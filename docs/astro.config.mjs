import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Corpus',
      description: 'Functional snapshotting library for TypeScript',
      logo: {
        src: './src/assets/logo.svg',
      },
      social: {
        github: 'https://github.com/f0rbit/corpus',
      },
      customCss: ['./src/styles/custom.css'],
      plugins: [
        starlightTypeDoc({
          entryPoints: ['../core.ts', '../backends.ts', '../codecs.ts'],
          tsconfig: '../tsconfig.build.json',
          output: 'api',
          sidebar: {
            label: 'API Reference',
            collapsed: false,
          },
          typeDoc: {
            excludePrivate: true,
            excludeProtected: true,
            excludeInternal: true,
            readme: 'none',
            categorizeByGroup: true,
            categoryOrder: ['Core', 'Backends', 'Codecs', 'Utilities', 'Types', '*'],
            sort: ['source-order'],
          },
        }),
      ],
      sidebar: [
        { label: 'Getting Started', slug: 'getting-started' },
        {
          label: 'Guides',
          items: [
            { label: 'Storage Backends', slug: 'guides/backends' },
            { label: 'Cloudflare Deployment', slug: 'guides/cloudflare' },
            { label: 'Testing Patterns', slug: 'guides/testing' },
          ],
        },
        typeDocSidebarGroup,
      ],
    }),
  ],
  site: 'https://f0rbit.github.io',
  base: '/corpus',
});
