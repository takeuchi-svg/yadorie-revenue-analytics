import type { NextConfig } from "next";

// GitHub Pages 向けビルド時のみ静的エクスポート。
// 通常（Vercel）は通常のNext.js（API Route有効）として動かす。
const isGhPages = process.env.DEPLOY_TARGET === 'gh-pages';

const nextConfig: NextConfig = {
  ...(isGhPages ? { output: 'export', basePath: '/yadorie-revenue-analytics' } : {}),
  images: { unoptimized: true },
};

export default nextConfig;
