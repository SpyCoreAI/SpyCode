import { Command, Option } from 'commander';
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve as resolvePath, join } from 'node:path';
import ora, { type Ora } from 'ora';
import { api } from '../../lib/api.js';
import { getToken } from '../../lib/auth.js';
import { resolveApiUrl } from '../../lib/config.js';
import { detectMime, formatFileSize } from '../../lib/files.js';
import { getOutputOptions, json, success, warn } from '../../lib/output.js';
import { uploadFile } from '../../lib/upload.js';
import {
  EXIT_USER_ERROR,
  SpycoreCliError,
} from '../../lib/errors.js';

interface UserMe {
  id: string;
  plan: string;
}

const PLAN_MAX_MB: Record<string, number> = {
  FREE: 0,
  STARTER: 100,
  PRO: 500,
  ULTIMATE: 1024,
  TEAM: 100,
  ENTERPRISE: 1024,
};

const PURPOSE_TO_CATEGORY: Record<string, string> = {
  chat: 'CHAT_OTHER',
  memory: 'CHAT_OTHER',
  image: 'CHAT_IMAGE',
  pdf: 'CHAT_PDF',
};

const STDIN_TMP_LIMIT_MB = 256;

async function bufferStdinToTempFile(remoteName: string): Promise<string> {
  const tmpPath = join(tmpdir(), `spycli-upload-${Date.now()}-${remoteName}`);
  return new Promise<string>((resolve, reject) => {
    const sink = createWriteStream(tmpPath);
    let bytes = 0;
    process.stdin.on('data', (chunk: Buffer | string) => {
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > STDIN_TMP_LIMIT_MB * 1024 * 1024) {
        process.stdin.pause();
        sink.destroy();
        try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
        reject(
          new SpycoreCliError(
            `stdin exceeded ${STDIN_TMP_LIMIT_MB} MB; pipe a file with --output instead.`,
            EXIT_USER_ERROR,
          ),
        );
      }
    });
    process.stdin.pipe(sink);
    sink.on('finish', () => resolve(tmpPath));
    sink.on('error', (err) => {
      try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      reject(err);
    });
  });
}

export function registerFilesUploadCommand(program: Command): void {
  program
    .command('upload <path>')
    .description('Upload a file (use "-" to read from stdin)')
    .addOption(new Option('-n, --name <name>', 'Override the remote filename'))
    .addOption(
      new Option('-p, --purpose <purpose>', 'Category hint sent to the server')
        .choices(['chat', 'memory', 'image', 'pdf'])
        .default('chat'),
    )
    .addOption(new Option('--mime <mime>', 'Override the MIME type sent in the multipart part'))
    .action(
      async (
        path: string,
        opts: { name?: string; purpose?: string; mime?: string },
        cmd: Command,
      ) => {
        const root = cmd.parent?.parent;
        const parentOpts = root?.opts<{ apiUrl?: string; json?: boolean }>() ?? {};

        // Resolve the local file (or buffer stdin to a temp file). We do
        // the plan/size check before touching the network so a Free user
        // gets a fast "upgrade" message rather than a server round-trip.
        let localPath: string;
        let cleanupTmp: string | null = null;
        const remoteName = opts.name?.trim() || (path === '-' ? 'stdin' : basename(path));

        if (path === '-') {
          localPath = await bufferStdinToTempFile(remoteName);
          cleanupTmp = localPath;
        } else {
          localPath = resolvePath(path);
          if (!existsSync(localPath)) {
            throw new SpycoreCliError(
              `File not found: ${localPath}`,
              EXIT_USER_ERROR,
            );
          }
          try {
            accessSync(localPath, constants.R_OK);
          } catch {
            throw new SpycoreCliError(
              `Cannot read file (permission denied): ${localPath}`,
              EXIT_USER_ERROR,
            );
          }
          const st = statSync(localPath);
          if (!st.isFile()) {
            throw new SpycoreCliError(
              `Not a regular file: ${localPath}`,
              EXIT_USER_ERROR,
            );
          }
        }

        try {
          const sizeBytes = statSync(localPath).size;

          // Cheap plan probe so the Free tier gets a clear local rejection.
          let plan: string | undefined;
          try {
            const me = await api.get<UserMe>('/api/user/me', {
              apiUrlOverride: parentOpts.apiUrl,
            });
            plan = me.plan;
          } catch {
            plan = undefined;
          }

          if (plan && plan in PLAN_MAX_MB) {
            const maxMb = PLAN_MAX_MB[plan] ?? 0;
            if (maxMb === 0) {
              throw new SpycoreCliError(
                'File uploads are available on Pro plans and above.',
                EXIT_USER_ERROR,
                'Upgrade at https://spycore.ai/pricing',
              );
            }
            if (sizeBytes > maxMb * 1024 * 1024) {
              throw new SpycoreCliError(
                `File is ${formatFileSize(sizeBytes)} — your plan allows up to ${maxMb} MB.`,
                EXIT_USER_ERROR,
                'Upgrade at https://spycore.ai/pricing',
              );
            }
          }

          const mime = opts.mime?.trim() || detectMime(remoteName);
          const apiUrl = resolveApiUrl(parentOpts.apiUrl).replace(/\/+$/, '');
          // `apiUrl` already ends in `/api`; the route is `/api/files/upload`.
          const url = `${apiUrl}/files/upload`;
          const token = await getToken();
          const headers: Record<string, string> = {
            'user-agent': '@spycore/cli',
            accept: 'application/json',
          };
          if (token) headers.authorization = `Bearer ${token}`;

          const useSpinner =
            !getOutputOptions().json && process.stdout.isTTY === true;
          let spinner: Ora | null = null;
          let nextRender = 0;
          if (useSpinner) {
            spinner = ora({
              text: `Uploading ${remoteName} (${formatFileSize(sizeBytes)})…`,
              stream: process.stderr,
            }).start();
          }

          let result;
          try {
            result = await uploadFile({
              path: localPath,
              url,
              headers,
              remoteName,
              mime,
              category: PURPOSE_TO_CATEGORY[opts.purpose ?? 'chat'] ?? 'CHAT_OTHER',
              onProgress: (loaded, total) => {
                if (!spinner || total === 0) return;
                const now = Date.now();
                if (now < nextRender && loaded < total) return;
                nextRender = now + 80;
                const pct = Math.min(100, Math.floor((loaded / total) * 100));
                const filled = Math.floor(pct / 5);
                const bar = '█'.repeat(filled).padEnd(20, '░');
                spinner.text = `Uploading ${remoteName} ${bar} ${pct}%`;
              },
            });
          } catch (err) {
            spinner?.fail();
            throw err;
          }

          spinner?.succeed(
            `Uploaded ${result.filename} (${formatFileSize(result.size)}) → ${result.id}`,
          );

          if (getOutputOptions().json) {
            json({
              id: result.id,
              url: result.url,
              size: result.size,
              mime: result.mime,
              filename: result.filename,
              expiresAt: result.expiresAt,
            });
          } else if (!useSpinner) {
            success(
              `Uploaded ${result.filename} (${formatFileSize(result.size)}) → ${result.id}`,
            );
          }
          if (result.expiresAt) {
            const expiry = new Date(result.expiresAt);
            warn(`Auto-expires at ${expiry.toISOString().slice(0, 10)}`);
          }
        } finally {
          if (cleanupTmp) {
            try { rmSync(cleanupTmp, { force: true }); } catch { /* ignore */ }
          }
        }
      },
    );
}
