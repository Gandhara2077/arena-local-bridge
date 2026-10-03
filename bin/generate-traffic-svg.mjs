#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const HISTORY_PATH = path.join(ROOT, "assets", "traffic-history.json");
const SVG_PATH = path.join(ROOT, "assets", "traffic.svg");

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmt(value) {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

function linePath(values, x0, y0, width, height, min = 0, max = Math.max(...values, 1)) {
  const span = Math.max(max - min, 1);
  return values.map((value, i) => {
    const x = x0 + (width * i) / Math.max(values.length - 1, 1);
    const y = y0 + height - ((value - min) / span) * height;
    return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function areaPath(values, x0, y0, width, height, max) {
  const line = values.map((value, i) => {
    const x = x0 + (width * i) / Math.max(values.length - 1, 1);
    const y = y0 + height - (value / Math.max(max, 1)) * height;
    return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  const lastX = x0 + width;
  return `${line} L ${lastX.toFixed(1)} ${(y0 + height).toFixed(1)} L ${x0} ${(y0 + height).toFixed(1)} Z`;
}

function bucket(days) {
  if (days.length <= 60) return days;
  const size = days.length > 365 ? 28 : 7;
  const out = [];
  for (let i = 0; i < days.length; i += size) {
    const group = days.slice(i, i + size);
    out.push({
      date: group[0].date,
      end: group.at(-1).date,
      views: group.reduce((s, d) => s + d.views, 0),
      clones: group.reduce((s, d) => s + d.clones, 0),
    });
  }
  return out;
}

function niceMax(value) {
  if (value <= 1) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * base;
}

function chartPanel({ title, subtitle, values, x, y, width, height }) {
  const maxValue = Math.max(...values, 1);
  const max = niceMax(maxValue);
  const path = linePath(values, x, y, width, height, 0, max);
  const area = areaPath(values, x, y, width, height, max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => {
    const gy = y + height * (1 - p);
    const value = max * p;
    return `
      <line x1="${x}" y1="${gy.toFixed(1)}" x2="${(x + width).toFixed(1)}" y2="${gy.toFixed(1)}" class="grid"/>
      <text x="${(x - 10).toFixed(1)}" y="${(gy + 3).toFixed(1)}" text-anchor="end" class="scale">${esc(fmt(Math.round(value)))}</text>
    `;
  }).join("");
  return `
    <text x="${x}" y="${y - 22}" class="panel-title">${esc(title)}</text>
    <text x="${x}" y="${y - 6}" class="panel-subtitle">${esc(subtitle)}</text>
    ${ticks}
    <path d="${area}" class="area"/>
    <path d="${path}" class="line"/>
  `;
}

const history = JSON.parse(await fs.readFile(HISTORY_PATH, "utf8"));
const days = [...(history.days ?? [])].sort((a, b) => a.date.localeCompare(b.date));
const points = bucket(days);
const periodLabel = days.length > 365 ? "4-week totals" : days.length > 60 ? "Weekly totals" : "Daily";
const labels = points.length === 0 ? [] : [...new Set([
  points[0]?.date,
  points[Math.floor((points.length - 1) / 2)]?.date,
  points.at(-1)?.date,
].filter(Boolean))];

const latest = history.latest_14_days ?? {};
const views = latest.views?.count;
const uniqueViews = latest.views?.uniques;
const clones = latest.clones?.count;
const uniqueClones = latest.clones?.uniques;

const W = 960;
const H = 600;
const pad = 54;
const chartX = 92;
const chartW = 814;
const panelH = 126;
const panel1Y = 232;
const panel2Y = 432;

const title = days.length
  ? `Since ${days[0].date}`
  : "Waiting for the first collection";
const subtitle = days.length
  ? `${days.length} daily records retained`
  : "GitHub Actions will populate this chart after the first run";

const xLabels = points.length ? labels.map((label) => {
  const idx = points.findIndex((p) => p.date === label);
  const xx = chartX + (chartW * idx) / Math.max(points.length - 1, 1);
  return `<text x="${xx.toFixed(1)}" y="578" text-anchor="${idx === 0 ? "start" : idx === points.length - 1 ? "end" : "middle"}" class="axis">${esc(label)}</text>`;
}).join("") : "";

let body = "";
if (points.length) {
  body += chartPanel({
    title: "Views",
    subtitle: periodLabel === "Daily" ? "Daily page views" : periodLabel + " page views",
    values: points.map((p) => p.views),
    x: chartX,
    y: panel1Y,
    width: chartW,
    height: panelH,
  });
  body += chartPanel({
    title: "Clones",
    subtitle: periodLabel === "Daily" ? "Daily repository clones" : periodLabel + " repository clones",
    values: points.map((p) => p.clones),
    x: chartX,
    y: panel2Y,
    width: chartW,
    height: panelH,
  });
  body += xLabels;
} else {
  body = `
    <rect x="54" y="232" width="852" height="326" rx="14" class="empty"/>
    <text x="480" y="370" text-anchor="middle" class="empty-title">Traffic history will appear here</text>
    <text x="480" y="397" text-anchor="middle" class="empty-text">The first scheduled or push-triggered collection will fetch GitHub's latest 14 days.</text>
  `;
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">Arena Local Bridge repository traffic</title>
  <desc id="desc">Views and clones collected from GitHub repository traffic data.</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .bg { fill: #ffffff; stroke: #d0d7de; }
    .title { fill: #1f2328; font-size: 24px; font-weight: 700; }
    .subtitle { fill: #656d76; font-size: 13px; }
    .card { fill: #f6f8fa; stroke: #d8dee4; }
    .card-label { fill: #656d76; font-size: 12px; font-weight: 600; }
    .card-value { fill: #1f2328; font-size: 22px; font-weight: 700; }
    .panel-title { fill: #1f2328; font-size: 15px; font-weight: 700; }
    .panel-subtitle { fill: #656d76; font-size: 11px; }
    .grid { stroke: #eaeef2; stroke-width: 1; }
    .line { fill: none; stroke: #0969da; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    .area { fill: #ddf4ff; opacity: .65; }
    .scale { fill: #8c959f; font-size: 10px; }
    .axis { fill: #656d76; font-size: 10px; }
    .empty { fill: #f6f8fa; stroke: #d8dee4; }
    .empty-title { fill: #1f2328; font-size: 17px; font-weight: 600; }
    .empty-text { fill: #656d76; font-size: 12px; }
    .footer { fill: #8c959f; font-size: 10px; }
  </style>
  <rect x="0.5" y="0.5" width="959" height="599" rx="16" class="bg"/>
  <text x="${pad}" y="48" class="title">Repository Traffic</text>
  <text x="${pad}" y="69" class="subtitle">${esc(title)} · ${esc(subtitle)}</text>

  <g>
    <rect x="54" y="94" width="198" height="92" rx="12" class="card"/>
    <text x="72" y="121" class="card-label">VIEWS · 14 DAYS</text>
    <text x="72" y="153" class="card-value">${fmt(views)}</text>

    <rect x="264" y="94" width="198" height="92" rx="12" class="card"/>
    <text x="282" y="121" class="card-label">UNIQUE VISITORS</text>
    <text x="282" y="153" class="card-value">${fmt(uniqueViews)}</text>

    <rect x="474" y="94" width="198" height="92" rx="12" class="card"/>
    <text x="492" y="121" class="card-label">CLONES · 14 DAYS</text>
    <text x="492" y="153" class="card-value">${fmt(clones)}</text>

    <rect x="684" y="94" width="222" height="92" rx="12" class="card"/>
    <text x="702" y="121" class="card-label">UNIQUE CLONERS</text>
    <text x="702" y="153" class="card-value">${fmt(uniqueClones)}</text>
  </g>

  ${body}

  <text x="54" y="594" class="footer">Source: GitHub Repository Traffic API · daily history retained by this repository</text>
</svg>
`;

await fs.writeFile(SVG_PATH, svg.replace(/[ \t]+$/gm, ""));
