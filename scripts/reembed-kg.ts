// reembed-kg.ts — re-embeds the knowledge graph with the configured embedding model (ADR-051).
//   pnpm reembed:kg            re-embed, resizing kg_nodes.embedding if the width changed
//   pnpm reembed:kg --dry-run  report what would change, and change nothing
// Run it with Curia stopped, after the boot log says the graph is off. Docker Compose recipe: docs/dev/setup.md.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { loadConfig, loadYamlConfig } from '../src/config.js';
import { createPool } from '../src/db/connection.js';
import { REEMBED_APPLICATION_NAME, describeInstanceLockHolder } from '../src/db/instance-lock.js';
import { loadEncryptionKey } from '../src/secrets/crypto.js';
import { SecretsService } from '../src/secrets/secrets-service.js';
import { applyVaultSecrets } from '../src/secrets/apply-vault-secrets.js';
import { EmbeddingService, describeEmbeddingUnavailable, resolveEmbedding } from '../src/memory/embedding.js';
import { reembedKnowledgeGraph } from '../src/memory/reembed.js';

const logger = pino({ name: 'reembed-kg', level: process.env.LOG_LEVEL ?? 'info' });

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
  const yamlConfig = loadYamlConfig(path.resolve(import.meta.dirname, '../config'));
  const pool = createPool(config.databaseUrl, logger, { applicationName: REEMBED_APPLICATION_NAME });
  try {
    await applyVaultSecrets(config, new SecretsService(pool, loadEncryptionKey(), logger), logger);
    const embedding = resolveEmbedding(config, yamlConfig.embedding?.profiles);
    if (!embedding.ok) {
      logger.error(`reembed-kg: ${describeEmbeddingUnavailable(embedding)}.`);
      return 1;
    }

    const result = await reembedKnowledgeGraph({
      pool,
      embeddingService: EmbeddingService.createWithEndpoint(embedding.endpoint, embedding.profile, logger),
      logger,
      dryRun,
    });
    switch (result.status) {
      case 'locked':
        logger.error(
          { holder: result.holder },
          `reembed-kg: Curia appears to be running: the instance lock is held by ${describeInstanceLockHolder(result.holder)}. ` +
          'Stop it first (docker stop curia-curia-1 on a Docker Compose install), then run this command again. Nothing was changed.',
        );
        return 1;
      case 'dry_run':
        logger.info(
          { rowsToEmbed: result.rowsToEmbed, widthChanges: result.widthChanges },
          'reembed-kg: DRY-RUN complete — nothing was changed',
        );
        return 0;
      case 'done':
        return 0;
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(code => process.exit(code))
    .catch((err: unknown) => {
      logger.error({ err }, 'reembed-kg: failed');
      process.exit(1);
    });
}
