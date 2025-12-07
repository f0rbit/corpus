import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightTypeDoc from 'starlight-typedoc';

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
            sort: ['source-order'],
            groupOrder: ['Functions', 'Type Aliases', '*'],
          },
        }),
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
            { label: 'Testing Patterns', slug: 'guides/testing' },
          ],
        },
        {
          label: 'API Reference',
          badge: { text: 'Auto-generated', variant: 'note' },
          items: [
            {
              label: 'Core',
              collapsed: false,
              items: [
                {
                  label: 'Functions',
                  collapsed: false,
                  items: [
                    { label: 'create_corpus', slug: 'api/core/functions/create_corpus' },
                    { label: 'create_store', slug: 'api/core/functions/create_store' },
                    { label: 'define_store', slug: 'api/core/functions/define_store' },
                    { label: 'ok', slug: 'api/core/functions/ok' },
                    { label: 'err', slug: 'api/core/functions/err' },
                  ],
                },
                {
                  label: 'Types',
                  collapsed: true,
                  items: [
                    { label: 'Corpus', slug: 'api/core/type-aliases/corpus' },
                    { label: 'CorpusBuilder', slug: 'api/core/type-aliases/corpusbuilder' },
                    { label: 'Store', slug: 'api/core/type-aliases/store' },
                    { label: 'StoreDefinition', slug: 'api/core/type-aliases/storedefinition' },
                    { label: 'Result', slug: 'api/core/type-aliases/result' },
                    { label: 'CorpusError', slug: 'api/core/type-aliases/corpuserror' },
                    { label: 'PutOpts', slug: 'api/core/type-aliases/putopts' },
                  ],
                },
              ],
            },
            {
              label: 'Backends',
              collapsed: false,
              items: [
                {
                  label: 'Functions',
                  collapsed: false,
                  items: [
                    { label: 'create_memory_backend', slug: 'api/backends/functions/create_memory_backend' },
                    { label: 'create_file_backend', slug: 'api/backends/functions/create_file_backend' },
                    { label: 'create_cloudflare_backend', slug: 'api/backends/functions/create_cloudflare_backend' },
                    { label: 'create_layered_backend', slug: 'api/backends/functions/create_layered_backend' },
                  ],
                },
                {
                  label: 'Types',
                  collapsed: true,
                  items: [
                    { label: 'Backend', slug: 'api/backends/type-aliases/backend' },
                    { label: 'MetadataClient', slug: 'api/backends/type-aliases/metadataclient' },
                    { label: 'DataClient', slug: 'api/backends/type-aliases/dataclient' },
                    { label: 'DataHandle', slug: 'api/backends/type-aliases/datahandle' },
                    { label: 'MemoryBackendOptions', slug: 'api/backends/type-aliases/memorybackendoptions' },
                    { label: 'FileBackendConfig', slug: 'api/backends/type-aliases/filebackendconfig' },
                    { label: 'CloudflareBackendConfig', slug: 'api/backends/type-aliases/cloudflarebackendconfig' },
                    { label: 'LayeredBackendOptions', slug: 'api/backends/type-aliases/layeredbackendoptions' },
                    { label: 'CorpusEvent', slug: 'api/backends/type-aliases/corpusevent' },
                    { label: 'EventHandler', slug: 'api/backends/type-aliases/eventhandler' },
                  ],
                },
              ],
            },
            {
              label: 'Codecs',
              collapsed: false,
              items: [
                {
                  label: 'Functions',
                  collapsed: false,
                  items: [
                    { label: 'json_codec', slug: 'api/codecs/functions/json_codec' },
                    { label: 'text_codec', slug: 'api/codecs/functions/text_codec' },
                    { label: 'binary_codec', slug: 'api/codecs/functions/binary_codec' },
                  ],
                },
                {
                  label: 'Types',
                  collapsed: true,
                  items: [
                    { label: 'Codec', slug: 'api/codecs/type-aliases/codec' },
                    { label: 'ContentType', slug: 'api/codecs/type-aliases/contenttype' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  ],
  site: 'https://f0rbit.github.io',
  base: '/corpus',
});
