import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import solidJs from '@astrojs/solid-js';

export default defineConfig({
  integrations: [
    solidJs(),
    starlight({
      title: '@f0rbit/corpus',
      description: 'Functional snapshotting library for TypeScript',
      logo: {
        src: './src/assets/logo.svg',
      },
      social: {
        github: 'https://github.com/f0rbit/corpus',
      },
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'meta',
          attrs: {
            name: 'google-site-verification',
            content: '3ilm2YAZDrg4jakb38CkhoubqHXKA_o4mMh4tFYCVls',
          },
        },
        ...(process.env.PULSE_PROJECT_ID && process.env.PULSE_INGEST_KEY ? [{
          tag: 'script',
          attrs: { type: 'module' },
          content: `
            import { createPulse } from 'https://esm.sh/@f0rbit/pulse-client@0.0.1';
            window.__pulse = createPulse({
              project_id: ${JSON.stringify(process.env.PULSE_PROJECT_ID)},
              ingest_key: ${JSON.stringify(process.env.PULSE_INGEST_KEY)},
              endpoint: ${JSON.stringify(process.env.PULSE_ENDPOINT || 'https://pulse.devpad.tools')},
              auto_pageview: true,
            });
          `.trim(),
        }] : []),
      ],
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
            { label: 'Events and Observability', slug: 'guides/events-and-observability' },
            { label: 'Observations', slug: 'guides/observations' },
            { label: 'Transactions', slug: 'guides/transactions' },
            { label: 'Version Sets', slug: 'guides/version-sets' },
            { label: 'Pipeline Templates', slug: 'guides/pipeline-templates' },
            { label: 'Testing Patterns', slug: 'guides/testing' },
          ],
        },
        {
          label: 'CLI',
          items: [
            { label: 'Overview', slug: 'cli/overview' },
            { label: 'Configuration', slug: 'cli/configuration' },
            { label: 'Clone Semantics', slug: 'cli/clone' },
          ],
        },
        {
          label: 'Testing',
          items: [
            { label: 'Overview', slug: 'testing/overview' },
            { label: 'Arbitraries', slug: 'testing/arbitraries' },
            { label: 'Laws', slug: 'testing/laws' },
            { label: 'Vending', slug: 'testing/vending' },
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
            { label: 'Extending', slug: 'api/extending-backends' },
          ],
        },
        {
          label: 'Codecs',
          slug: 'api/codecs',
        },
        {
          label: 'Streaming',
          slug: 'api/streaming',
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
