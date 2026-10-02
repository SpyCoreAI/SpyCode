import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import {
  discoverSkills,
  parseSkillFile,
  projectSkillsDir,
  userSkillsDir,
} from '../../lib/agent/skills.js';
import {
  emptySyncState,
  officialSkillNames,
  planSkillSync,
  readSyncState,
  removeSyncedSkill,
  syncedSkillExists,
  writeSyncState,
  writeSyncedSkill,
  type SkillManifestEntry,
  type SyncState,
} from '../../lib/skills-sync.js';
import { api } from '../../lib/api.js';
import { isAuthenticated } from '../../lib/auth.js';
import { EXIT_AUTH_ERROR, EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { getOutputOptions, info, json, print, success, warn } from '../../lib/output.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { registerCreate } from './create.js';
import { registerRemove } from './remove.js';

/**
 * `spycore skills <subcommand>` — manage the local agent skills the CLI
 * discovers for `spycore agent` runs. Skills live as `<dir>/SKILL.md` under
 * the project (./.spycore/skills/) and the user config dir; project wins on a
 * name collision. list/show inspect, sync downloads the official catalog,
 * create generates a new skill from a description (see create.ts), and
 * remove deletes a user-created/project one (sync owns official skills).
 */

function registerList(group: Command): void {
  group
    .command('list')
    .description('List installed agent skills (project + user-global)')
    .action(() => {
      const cwd = process.cwd();
      const skills = discoverSkills(cwd);
      // User-global skills the sync ledger owns are shown as `official`.
      const official = officialSkillNames();
      const sourceLabel = (s: { name: string; source: 'project' | 'user' }): string =>
        s.source === 'user' && official.has(s.name) ? 'official' : s.source;
      if (getOutputOptions().json) {
        json({
          projectDir: projectSkillsDir(cwd),
          userDir: userSkillsDir(),
          skills: skills.map((s) => ({ name: s.name, source: sourceLabel(s), description: s.description })),
        });
        return;
      }
      if (skills.length === 0) {
        info('No skills installed.');
        print(`Add one by creating SKILL.md under ${projectSkillsDir(cwd)}/<name>/ (project)`);
        print(`or ${userSkillsDir()}/<name>/ (all projects), or run \`spycore skills sync\`.`);
        return;
      }
      // name + description come from untrusted SKILL.md frontmatter — sanitize
      // before printing so ANSI/control sequences can't drive the terminal.
      // (The --json path above stays raw; JSON.stringify escapes C0 controls.)
      const rows = skills.map((s) => ({
        name: sanitizeForDisplay(s.name),
        source: sourceLabel(s),
        description: sanitizeForDisplay(s.description),
      }));
      const wName = Math.max('NAME'.length, ...rows.map((r) => r.name.length));
      const wSource = Math.max('SOURCE'.length, ...rows.map((r) => r.source.length));
      print(`${'NAME'.padEnd(wName)}  ${'SOURCE'.padEnd(wSource)}  DESCRIPTION`);
      for (const r of rows) {
        print(`${r.name.padEnd(wName)}  ${r.source.padEnd(wSource)}  ${r.description}`);
      }
    });
}

function registerShow(group: Command): void {
  group
    .command('show <name>')
    .description("Print a skill's full instructions (the SKILL.md body)")
    .action((name: string) => {
      const cwd = process.cwd();
      const skills = discoverSkills(cwd);
      const skill = skills.find((s) => s.name === name.trim());
      if (!skill) {
        throw new SpycoreCliError(
          `No skill named "${name}".`,
          EXIT_USER_ERROR,
          skills.length > 0
            ? `Installed: ${skills.map((s) => s.name).join(', ')}`
            : 'No skills are installed — see `spycore skills list`.',
        );
      }
      let raw: string;
      try {
        raw = readFileSync(skill.path, 'utf8');
      } catch {
        throw new SpycoreCliError(`Skill "${skill.name}" could not be read.`, EXIT_USER_ERROR);
      }
      const parsed = parseSkillFile(raw, skill.name);
      if (getOutputOptions().json) {
        json({ name: skill.name, source: skill.source, description: skill.description, body: parsed.body });
        return;
      }
      // The body is untrusted SKILL.md content — sanitize control/escape
      // sequences before printing so it can't drive the terminal (the --json
      // path above stays raw; JSON.stringify escapes C0 controls).
      print(sanitizeForDisplay(parsed.body));
    });
}

interface ManifestResp {
  totalSkills: number;
  skills: SkillManifestEntry[];
}
interface ContentResp {
  name: string;
  description: string;
  content: string;
}

function registerSync(group: Command): void {
  group
    .command('sync')
    .description('Download the official skill catalog into your user-global skills dir (requires login)')
    .addOption(new Option('--force', 'Re-download every official skill even when unchanged'))
    .action(async (opts: { force?: boolean }, cmd: Command) => {
      // --api-url rides on the root program (group → program).
      const rootOpts = cmd.parent?.parent?.opts<{ apiUrl?: string }>() ?? {};
      const apiUrlOverride = rootOpts.apiUrl;
      if (!(await isAuthenticated())) {
        throw new SpycoreCliError(
          'Not logged in.',
          EXIT_AUTH_ERROR,
          'Skills sync needs a SpyCore account — run `spycore login` first.',
        );
      }

      const manifest = await api.get<ManifestResp>('/v1/skills/manifest', { apiUrlOverride });
      const entries = Array.isArray(manifest.skills) ? manifest.skills : [];
      const state = readSyncState();
      const plan = planSkillSync(entries, state, syncedSkillExists, Boolean(opts.force));

      // Next ledger: start from unchanged entries; downloads/removals adjust it.
      const next: SyncState = emptySyncState();
      for (const name of plan.unchanged) {
        const prev = state.skills[name];
        if (prev) next.skills[name] = prev;
      }
      const byName = new Map(entries.map((e) => [e.name, e]));
      let added = 0;
      let updated = 0;
      try {
        for (const dl of plan.download) {
          const meta = byName.get(dl.name);
          if (!meta) continue;
          const resp = await api.get<ContentResp>(`/v1/skills/${encodeURIComponent(dl.name)}/content`, {
            apiUrlOverride,
          });
          writeSyncedSkill(dl.name, resp.content);
          next.skills[dl.name] = { sha256: meta.sha256 };
          if (dl.kind === 'added') added += 1;
          else updated += 1;
        }
        for (const name of plan.removals) {
          removeSyncedSkill(name);
        }
      } finally {
        // Persist whatever was applied even if a download midway failed, so
        // already-written skills stay ledger-owned (never mistaken for
        // user-created content on the next run).
        next.lastSync = new Date().toISOString();
        writeSyncState(next);
      }

      for (const name of plan.skipped) {
        warn(`skipped "${sanitizeForDisplay(name)}" — a local skill you created has that name (your version wins)`);
      }
      // Manifest entries with an unsafe name are refused before any FS op
      // (SEC-012). Sanitize the name before printing it — it's untrusted and
      // could carry terminal-control sequences.
      for (const name of plan.rejected) {
        warn(`rejected "${sanitizeForDisplay(name)}" — unsafe skill name in the catalog (ignored)`);
      }
      const summary = {
        added,
        updated,
        removed: plan.removals.length,
        unchanged: plan.unchanged.length,
        skipped: plan.skipped.length,
        rejected: plan.rejected.length,
        total: entries.length,
      };
      if (getOutputOptions().json) {
        json(summary);
        return;
      }
      success(
        `Skills synced: added ${summary.added}, updated ${summary.updated}, removed ${summary.removed}, unchanged ${summary.unchanged}${summary.skipped > 0 ? `, skipped ${summary.skipped}` : ''}${summary.rejected > 0 ? `, rejected ${summary.rejected}` : ''}.`,
      );
      if (added + updated > 0) {
        info('They are available to every agent run (any provider) via load_skill.');
      }
    });
}

export function registerSkillsCommand(program: Command): void {
  const group = program
    .command('skills')
    .description('List, create and sync local agent skills (SKILL.md guides the agent can load)');

  registerList(group);
  registerShow(group);
  registerSync(group);
  registerCreate(group);
  registerRemove(group);

  group
    .command('help', { isDefault: true, hidden: true })
    .description('Show help for the skills subcommand')
    .action(() => {
      group.help();
    });
}
