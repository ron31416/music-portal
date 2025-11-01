// next-sitemap.config.js
/** @type {import('next-sitemap').IConfig} */
const isProd = process.env.VERCEL_ENV === 'production';

module.exports = {
  // now driven by env per environment (dev/staging/prod)
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000',

  generateRobotsTxt: true,

  // optional: keep previews out of Google, identical to your current logic
  robotsTxtOptions: isProd
    ? {}
    : { policies: [{ userAgent: '*', disallow: '/' }] },
};
