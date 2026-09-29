// §P1-2 — the browser really has one context per Account, and a context is only
// thrown away when nobody is using it.
//
// The whole point: a credential refresh used to close the browser, which killed
// every page in it, including the turn that was running. Now a refresh only
// marks that Account's context stale, and the rebuild waits for it to go idle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ArenaBrowser, contextAction } from "../src/arena-login.mjs";

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
  assert.ok(await browser.getPage(null));
  assert.ok(await browser.getPage());
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
        addInitScript: async () => {},
        addCookies: async (list) => context.cookies.push(...list),
        newPage: async () => ({ isClosed: () => false, addInitScript: async () => {} }),
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

test("getPage: the same Account with an unchanged credential keeps its context", async () => {
  const browser = browserWithFake();
  await browser.getPage(A);
  await browser.getPage(A);
  assert.equal(browser.browser.contexts.length, 1);
});


test("getPage: two Accounts never share a context", async () => {
  const browser = browserWithFake();
  await browser.getPage(A);
  await browser.getPage(B);
  assert.equal(browser.browser.contexts.length, 2);
  assert.equal(browser.browser.contexts[0].closed, false);
});

test("getPage: a refreshed credential rebuilds the context once it is idle", async () => {
  const browser = browserWithFake();
  await browser.getPage(A); // 没有 operation 持有它
  await browser.getPage({ ...A, cookieHeader: "arena-auth-prod-v1=a2", updatedAt: "2026-02-02T00:00:00Z" });
  assert.equal(browser.browser.contexts.length, 2);
  assert.equal(browser.browser.contexts[0].closed, true, "旧的 context 必须被关掉，否则泄漏");
});

test("getPage: a refresh does NOT yank a context that is in use", async () => {
  const browser = browserWithFake();
  const refreshed = { ...A, cookieHeader: "arena-auth-prod-v1=a2", updatedAt: "2026-02-02T00:00:00Z" };
  await browser.getPage(A);
  await browser.withAccount(A, async () => {
    // 一个 turn 正在跑，期间发生了刷新
    await browser.getPage(refreshed);
    assert.equal(browser.browser.contexts.length, 1, "turn 还在跑，不能重建");
    assert.equal(browser.browser.contexts[0].closed, false);
  });
  // turn 结束、账号空闲之后，下一次取页面才重建
  await browser.getPage(refreshed);
  assert.equal(browser.browser.contexts.length, 2);
});

test("getPage: the rebuild happens on the next call after the last lease is released", async () => {
  const browser = browserWithFake();
  const refreshed = { ...A, cookieHeader: "arena-auth-prod-v1=a2", updatedAt: "2026-02-02T00:00:00Z" };
  await browser.getPage(A);
  // turn #1 还在跑：期间刷新，第二个请求进来也只能先沿用旧的
  await browser.withAccount(A, async () => {
    await browser.getPage(refreshed);
    assert.equal(browser.browser.contexts.length, 1);
  });
  assert.equal(browser.leaseCount(A.email), 0, "turn 结束后租约必须归零");
  // 空闲之后的第一次取页面才重建
  await browser.getPage(refreshed);
  assert.equal(browser.browser.contexts.length, 2);
});

test("getPage: another Account is untouched by A's refresh", async () => {
  const browser = browserWithFake();
  await browser.getPage(B);
  await browser.getPage(A);
  const bContext = browser.browser.contexts[0];
  await browser.getPage({ ...A, updatedAt: "2026-02-02T00:00:00Z" });
  assert.equal(browser.browser.contexts.length, 3, "B 一个 + A 的两个版本");
  assert.equal(bContext.closed, false, "B 的 context 不能被 A 的刷新波及");
});

test("withAccount: an operation that does not hold the context cannot block a rebuild", async () => {
  const browser = browserWithFake();
  await browser.getPage(A); // 例如 start() 的预热：取完就走，不持租约
  await browser.getPage({ ...A, updatedAt: "2026-02-02T00:00:00Z" });
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
  await browser.getPage(A);
  await browser.getPage(B);
  await browser.close();
  assert.equal(fake.contexts.every((c) => c.closed), true);
  assert.equal(browser.browser, null);
});
