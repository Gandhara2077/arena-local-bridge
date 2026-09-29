// §P1-2 — the browser really has one context per Account, and a context is only
// thrown away when nobody is using it.
//
// The whole point: a credential refresh used to close the browser, which killed
// every page in it, including the turn that was running. Now a refresh only
// marks that Account's context stale, and the rebuild waits for it to go idle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ArenaBrowser, contextAction, pageAction, PAGE_PURPOSES } from "../src/arena-login.mjs";

const A = { email: "a@example.com", cookieHeader: "arena-auth-prod-v1=a", updatedAt: "2026-01-01T00:00:00Z" };
const B = { email: "b@example.com", cookieHeader: "arena-auth-prod-v1=b", updatedAt: "2026-01-01T00:00:00Z" };

// ── the decision itself ─────────────────────────────────────────────────────

test("contextAction: creates when the Account has no context yet", () => {
  assert.equal(contextAction({ hasContext: false }), "create");
  // A dirty flag with no context still just means "create".
  assert.equal(contextAction({ hasContext: false, dirty: true, leases: 3 }), "create");
});

test("contextAction: reuses an up-to-date context", () => {
  assert.equal(contextAction({ hasContext: true }), "reuse");
  assert.equal(contextAction({ hasContext: true, dirty: false, leases: 2 }), "reuse");
});

test("contextAction: rebuilds a stale context once it is idle", () => {
  assert.equal(contextAction({ hasContext: true, dirty: true, leases: 0 }), "rebuild");
});

test("contextAction: a stale context in use is left alone", () => {
  // This is the case that used to break: rebuilding here would close the pages
  // out from under a turn that is still running.
  assert.equal(contextAction({ hasContext: true, dirty: true, leases: 1 }), "reuse-stale");
});

// ── the argument contract ───────────────────────────────────────────────────

// getPage() used to take (cookieHeader, updatedAt). A call site left on that
// signature reaches the new implementation with a bare string, and every field
// it reads comes back undefined — so it would quietly drive an ANONYMOUS context
// instead of the Account's. Rejecting the shape here makes the miss loud.
test("getPage: rejects a bare cookie header instead of quietly going anonymous", async () => {
  const browser = browserWithFake();
  await assert.rejects(
    browser.getPage("arena-auth-prod-v1=abc", "2026-01-01T00:00:00Z"),
    (error) => {
      assert.ok(error instanceof TypeError, `expected a TypeError, got ${error}`);
      assert.match(error.message, /credential object/);
      return true;
    }
  );
  assert.equal(browser.browser.contexts.length, 0, "拒绝之后不得顺手建出一个匿名 context");
});

test("getPage: any shape without an Account identity is rejected", async () => {
  const browser = browserWithFake();
  // A partially migrated call ({ cookieHeader, updatedAt } but no email) would
  // land on the same anonymous context as a bare string, so it has to fail too.
  const bad = [42, true, "arena-auth-prod-v1=abc", [], {}, { cookieHeader: "a=1", updatedAt: "now" }, { email: "  " }];
  for (const value of bad) {
    await assert.rejects(browser.getPage(value), TypeError, `should reject ${JSON.stringify(value)}`);
  }
});

test("getPage: an explicit no-credential call is still allowed", async () => {
  // `null` is the deliberate "no Account yet" path, not a mistaken call.
  const browser = browserWithFake();
  assert.ok(await browser.getPage(null, "converse"));
  assert.ok(await browser.getPage(undefined, "converse"));
});

// ── the orchestration ───────────────────────────────────────────────────────

function fakeBrowser() {
  const contexts = [];
  return {
    contexts,
    newContext: async () => {
      const context = {
        closed: false,
        cookies: [],
        //每页一个可辨认的对象：这些测试要断言的正是「拿到了哪一页」。
        pages: [],
        addInitScript: async () => {},
        addCookies: async (list) => context.cookies.push(...list),
        newPage: async () => {
          const page = {
            isClosed: () => page.closed,
            closed: false,
            // Counted so the probe can be asserted per page.
            initScripts: 0,
            close: async () => {
              page.closed = true;
            },
            addInitScript: async () => {
              page.initScripts += 1;
            },
          };
          context.pages.push(page);
          return page;
        },
        close: async () => {
          context.closed = true;
        },
      };
      contexts.push(context);
      return context;
    },
    close: async () => {},
    isConnected: () => true,
  };
}

function browserWithFake() {
  const browser = new ArenaBrowser({});
  browser.browser = fakeBrowser();
  return browser;
}

/** The browser only ever builds one context here, so this is "the" context. */
function onlyContext(browser) {
  assert.equal(browser.browser.contexts.length, 1, "这一步不该多建 context");
  return browser.browser.contexts[0];
}

test("getPage: the same Account with an unchanged credential keeps its context", async () => {
  const browser = browserWithFake();
  await browser.getPage(A, "converse");
  await browser.getPage(A, "converse");
  assert.equal(browser.browser.contexts.length, 1);
});


test("getPage: two Accounts never share a context", async () => {
  const browser = browserWithFake();
  await browser.getPage(A, "converse");
  await browser.getPage(B, "converse");
  assert.equal(browser.browser.contexts.length, 2);
  assert.equal(browser.browser.contexts[0].closed, false);
});

test("getPage: a refreshed credential rebuilds the context once it is idle", async () => {
  const browser = browserWithFake();
  await browser.getPage(A, "converse"); // 没有 operation 持有它
  await browser.getPage({ ...A, cookieHeader: "arena-auth-prod-v1=a2", updatedAt: "2026-02-02T00:00:00Z" }, "converse");
  assert.equal(browser.browser.contexts.length, 2);
  assert.equal(browser.browser.contexts[0].closed, true, "旧的 context 必须被关掉，否则泄漏");
});

test("getPage: a refresh does NOT yank a context that is in use", async () => {
  const browser = browserWithFake();
  const refreshed = { ...A, cookieHeader: "arena-auth-prod-v1=a2", updatedAt: "2026-02-02T00:00:00Z" };
  await browser.getPage(A, "converse");
  await browser.withAccount(A, async () => {
    // 一个 turn 正在跑，期间发生了刷新
    await browser.getPage(refreshed, "converse");
    assert.equal(browser.browser.contexts.length, 1, "turn 还在跑，不能重建");
    assert.equal(browser.browser.contexts[0].closed, false);
  });
  // turn 结束、账号空闲之后，下一次取页面才重建
  await browser.getPage(refreshed, "converse");
  assert.equal(browser.browser.contexts.length, 2);
});

test("getPage: the rebuild happens on the next call after the last lease is released", async () => {
  const browser = browserWithFake();
  const refreshed = { ...A, cookieHeader: "arena-auth-prod-v1=a2", updatedAt: "2026-02-02T00:00:00Z" };
  await browser.getPage(A, "converse");
  // turn #1 还在跑：期间刷新，第二个请求进来也只能先沿用旧的
  await browser.withAccount(A, async () => {
    await browser.getPage(refreshed, "converse");
    assert.equal(browser.browser.contexts.length, 1);
  });
  assert.equal(browser.leaseCount(A.email), 0, "turn 结束后租约必须归零");
  // 空闲之后的第一次取页面才重建
  await browser.getPage(refreshed, "converse");
  assert.equal(browser.browser.contexts.length, 2);
});

test("getPage: another Account is untouched by A's refresh", async () => {
  const browser = browserWithFake();
  await browser.getPage(B, "converse");
  await browser.getPage(A, "converse");
  const bContext = browser.browser.contexts[0];
  await browser.getPage({ ...A, updatedAt: "2026-02-02T00:00:00Z" }, "converse");
  assert.equal(browser.browser.contexts.length, 3, "B 一个 + A 的两个版本");
  assert.equal(bContext.closed, false, "B 的 context 不能被 A 的刷新波及");
});

test("withAccount: an operation that does not hold the context cannot block a rebuild", async () => {
  const browser = browserWithFake();
  await browser.getPage(A, "converse"); // 例如 start() 的预热：取完就走，不持租约
  await browser.getPage({ ...A, updatedAt: "2026-02-02T00:00:00Z" }, "converse");
  assert.equal(browser.browser.contexts.length, 2, "不持租约的调用不该挡住重建");
});

test("withAccount: nests, and always returns the lease — even when fn throws", async () => {
  const browser = browserWithFake();
  await browser.withAccount(A, async () => {
    await browser.withAccount(A, async () => {
      assert.equal(browser.leaseCount(A.email), 2);
    });
    assert.equal(browser.leaseCount(A.email), 1);
  });
  assert.equal(browser.leaseCount(A.email), 0);

  await assert.rejects(
    browser.withAccount(A, async () => {
      throw new Error("turn blew up");
    }),
    /turn blew up/
  );
  assert.equal(browser.leaseCount(A.email), 0, "抛异常也必须归还租约");
  browser.release("nobody@example.com"); // 未知账号不能抛
});

test("close: closes every Account's context and the browser", async () => {
  const browser = browserWithFake();
  const fake = browser.browser;
  await browser.getPage(A, "converse");
  await browser.getPage(B, "converse");
  await browser.close();
  assert.equal(fake.contexts.every((c) => c.closed), true);
  assert.equal(browser.browser, null);
});

// ── a page per purpose (ticket 08) ──────────────────────────────────────────
//
// A lease protects the CONTEXT's lifetime, not a page's use. Two operations on
// the same Account each need their own page, or one navigating away makes the
// other read the wrong document. The purpose is what tells them apart: a
// harvest must not be driving the page a turn is on.

test("pageAction: an open page is reused; a missing or closed one is created", () => {
  assert.equal(pageAction({ hasPage: true, closed: false }), "reuse");
  assert.equal(pageAction({ hasPage: false }), "create");
  // A page the site or a crash closed is not a page: reusing it throws at the
  // first call on it, far away from here.
  assert.equal(pageAction({ hasPage: true, closed: true }), "create");
});

test("getPage: every purpose it knows is accepted", async () => {
  const browser = browserWithFake();
  for (const purpose of Object.keys(PAGE_PURPOSES)) assert.ok(await browser.getPage(A, purpose), purpose);
});

test("getPage: the purpose is required, because a default would pick a page for you", async () => {
  // Omitting it would silently land on someone else's page — the failure this
  // whole indirection exists to prevent.
  const browser = browserWithFake();
  await assert.rejects(browser.getPage(A, undefined), TypeError);
  assert.equal(browser.browser.contexts.length, 0, "拒绝之后不得顺手建出 context");
});

test("getPage: two purposes share the Account's context but never its page", async () => {
  const browser = browserWithFake();
  const turn = await browser.getPage(A, "converse");
  const harvest = await browser.getPage(A, "harvest");
  assert.notEqual(turn, harvest, "两个 operation 不能拿到同一页");
  assert.equal(onlyContext(browser).pages.length, 2, "一 Account 一 context，但每 purpose 一页");
});

test("getPage: the same purpose gets the same page back", async () => {
  // A turn asks for its page several times, and the quota read is written
  // against the page a finished turn left behind — so this has to be stable.
  const browser = browserWithFake();
  const first = await browser.getPage(A, "converse");
  assert.equal(await browser.getPage(A, "converse"), first);
  assert.equal(onlyContext(browser).pages.length, 1);
});

test("getPage: a rebuilt context hands out fresh pages, not the dead ones", async () => {
  const browser = browserWithFake();
  const refreshed = { ...A, cookieHeader: "arena-auth-prod-v1=a2", updatedAt: "2026-02-02T00:00:00Z" };
  const before = await browser.getPage(A, "converse");
  await browser.getPage(refreshed, "converse"); // 空闲 → 重建
  assert.equal(browser.browser.contexts.length, 2, "旧 context 关掉，新 context 建起来");
  const after = await browser.getPage(refreshed, "converse");
  assert.notEqual(after, before, "旧 context 里的 page 已经跟着死了");
  assert.equal(after.isClosed(), false);
  assert.equal(browser.browser.contexts.at(-1).pages.length, 1, "新 context 只建该 purpose 的页");
});

test("getPage: a page that got closed is replaced", async () => {
  const browser = browserWithFake();
  const first = await browser.getPage(A, "converse");
  first.closed = true;
  assert.notEqual(await browser.getPage(A, "converse"), first);
});

test("getPage: an unknown purpose is rejected before anything is created", async () => {
  // Without this check a typo quietly becomes a purpose of its own: every call
  // makes a fresh page, and anything that reads state a previous run left
  // behind finds an empty document instead of failing where the mistake is.
  const browser = browserWithFake();
  for (const purpose of ["harvestt", "", "CONVERSE"]) {
    await assert.rejects(browser.getPage(A, purpose), TypeError, purpose);
  }
  assert.equal(browser.browser.contexts.length, 0, "拒绝之后不得顺手建出 context");
});

test("getPage: every page it hands out carries the probe, once", async () => {
  // The USD reading comes from a trace the probe leaves behind, so a page
  // without it silently answers "no data" for that purpose. Once, because
  // re-adding the init script makes every navigation re-parse the bundle.
  const browser = browserWithFake();
  await browser.getPage(A, "converse");
  await browser.getPage(A, "harvest");
  await browser.getPage(A, "harvest");
  const pages = onlyContext(browser).pages;
  assert.deepEqual(pages.map((page) => page.initScripts), [1, 1]);
});

test("getPage: the reCAPTCHA page is a purpose of its own, and carries no probe", async () => {
  // Deliberately long-lived — it holds Google's loaded script — but it lives
  // and dies with the context, like every other page. No probe: it never runs a
  // conversation, so the bundle would only be re-parsed on each navigation.
  const browser = browserWithFake();
  const page = await browser.getPage(A, "recaptcha");
  assert.equal(await browser.getPage(A, "recaptcha"), page);
  assert.deepEqual(
    onlyContext(browser).pages.map((p) => p.initScripts),
    [0]
  );
  assert.deepEqual(browser.snapshot().accounts[0].pages, ["recaptcha"]);
});

test("snapshot: reports which purposes hold a page", async () => {
  const browser = browserWithFake();
  await browser.getPage(A, "converse");
  await browser.getPage(A, "harvest");
  await browser.getPage(B, "reprobe");
  assert.deepEqual(
    browser.snapshot().accounts.map((account) => [account.account, account.pages]),
    [
      [A.email, ["converse", "harvest"]],
      [B.email, ["reprobe"]],
    ]
  );
});
