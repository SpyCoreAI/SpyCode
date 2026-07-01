import { Command } from 'commander';
import os from 'node:os';
import { getOutputOptions, json, print } from '../lib/output.js';
import { getConfigPath } from '../lib/config.js';

export interface VersionInfo {
  cli: string;
  node: string;
  os: string;
  arch: string;
  configPath: string;
}

/**
 * `spycore version` — full diagnostic block (CLI + Node + OS + config dir).
 *
 * The top-level `--version` flag (registered in src/index.ts) prints just
 * the CLI version on its own. This command exists so users have a single
 * place to grab everything support might ask for.
 */
export function registerVersionCommand(program: Command, cliVersion: string): void {
  program
    .command('version')
    .description('Show CLI version, Node version, and platform info')
    .action(() => {
      const info: VersionInfo = {
        cli: cliVersion,
        node: process.version,
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        configPath: getConfigPath(),
      };

      if (getOutputOptions().json) {
        json(info);
        return;
      }

      print(`spycore CLI ${info.cli}`);
      print(`  Node:    ${info.node}`);
      print(`  OS:      ${info.os}`);
      print(`  Arch:    ${info.arch}`);
      print(`  Config:  ${info.configPath}`);
    });
}
