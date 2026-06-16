import type { NextConfig } from "next";

const isGhPages = process.env.DEPLOY_TARGET === 'gh-pages';

const nextConfig: NextConfig = {
  output: 'export',
  basePath: isGhPages ? '/yadorie-revenue-analytics' : '',
  images: { unoptimized: true },
};

export default nextConfig;
