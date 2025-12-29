import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

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
      sidebar: [
        {
          label: 'Getting Started',
          slug: 'getting-started',
        },
        {
          label: 'Guides',
          items: [
            { label: 'Storage Backends', slug: 'guides/backends' },
            { label: 'Cloudflare Deployment', slug: 'guides/cloudflare' },
            { label: 'Observations', slug: 'guides/observations' },
            { label: 'Testing Patterns', slug: 'guides/testing' },
          ],
        },
        {
          label: 'Core',
          items: [
            { label: 'create_corpus', slug: 'api/core/create-corpus' },
            { label: 'create_store', slug: 'api/core/create-store' },
            { label: 'define_store', slug: 'api/core/define-store' },
            { label: 'Observations', slug: 'api/core/observations' },
            { label: 'Types', slug: 'api/core/types' },
          ],
        },
        {
          label: 'Backends',
          items: [
            { label: 'Memory', slug: 'api/backends/memory' },
            { label: 'File System', slug: 'api/backends/file' },
            { label: 'Cloudflare', slug: 'api/backends/cloudflare' },
            { label: 'Layered', slug: 'api/backends/layered' },
            { label: 'Types', slug: 'api/backends/types' },
          ],
        },
        {
          label: 'Codecs',
          slug: 'api/codecs',
        },
        {
          label: 'Utilities',
          slug: 'api/utilities',
        },
      ],
    }),
  ],
  site: 'https://f0rbit.github.io',
  base: '/corpus',
});
