import { describe, expect, test } from 'vitest';
import {
  matchesCatastrophic,
  screenWindowsCommand,
} from '../src/lib/agent/tools.js';

/**
 * H4 - the catastrophic screen was POSIX-sh only, but `runShellCommand`
 * spawns with `shell: true` - cmd.exe on Windows. Native Windows
 * destructive commands were never screened. Every form below must be
 * refused by `matchesCatastrophic` (the single gate on `run_command`),
 * on any platform, while ordinary commands stay allowed.
 */
describe('Windows-native catastrophic commands are screened', () => {
  const blocked = (c: string): boolean => matchesCatastrophic(c) !== null;

  test('recursive delete: rd / rmdir / del / erase with /s', () => {
    for (const c of [
      'rd /s /q C:\\Users\\alice\\project',
      'rd /s C:\\temp',
      'rmdir /s /q D:\\data',
      'del /s /q C:\\Users\\alice\\*.tmp',
      'erase /s C:\\temp\\*.*',
      'RD /S /Q C:\\temp',
      'C:\\Windows\\System32\\rd.exe /s /q C:\\temp',
      'rd /s /q C:\\temp & echo done',
      'echo start && del /s /q C:\\temp',
    ]) {
      expect(blocked(c), c).toBe(true);
      expect(screenWindowsCommand(c), c).not.toBe(null);
    }
  });

  test('format, diskpart, reg delete, bcdedit, cipher /w, vssadmin delete shadows', () => {
    for (const c of [
      'format C: /q',
      'format D:',
      'FORMAT E: /FS:NTFS',
      'diskpart',
      'diskpart /s script.txt',
      'reg delete HKLM\\Software\\Vendor /f',
      'REG DELETE HKCU\\Software\\Vendor /va',
      'bcdedit /delete {current}',
      'bcdedit /set {default} safeboot minimal',
      'cipher /w:C:\\',
      'vssadmin delete shadows /all',
      'vssadmin Delete Shadows /for=C: /quiet',
    ]) {
      expect(blocked(c), c).toBe(true);
    }
  });

  test('cmd /c and powershell -c payloads are screened recursively', () => {
    for (const c of [
      'cmd /c "rd /s /q C:\\temp"',
      'cmd /c rd /s C:\\temp',
      'powershell -c "Remove-Item -Recurse -Force C:\\temp"',
      'powershell -Command "Format-Volume -DriveLetter D"',
      'pwsh -c "Get-ChildItem C:\\temp | Remove-Item -Recurse"',
      'powershell -c "Clear-RecycleBin -Force"',
      // NOTE: `-EncodedCommand` payloads are opaque base64 and stay out of
      // scope, exactly as encoded payloads are for the POSIX screen.
    ]) {
      expect(blocked(c), c).toBe(true);
    }
  });

  test('R1-2 - powershell -c / -Command takes the rest of the line, unquoted', () => {
    for (const c of [
      'powershell -c Remove-Item -Recurse C:\\',
      'pwsh -Command Remove-Item -Recurse C:\\',
      'powershell -c Remove-Item -Recurse -Force C:\\temp',
      'pwsh -Command Format-Volume -DriveLetter D',
    ]) {
      expect(blocked(c), c).toBe(true);
    }
  });

  test('ordinary commands - POSIX and Windows alike - stay allowed', () => {
    for (const c of [
      'echo hello',
      'dir C:\\Users\\alice',
      'rd /q C:\\temp\\emptydir',
      'del C:\\temp\\file.txt',
      'type C:\\temp\\notes.txt',
      'reg query HKLM\\Software\\Vendor',
      'bcdedit /enum',
      'cipher /e C:\\temp\\file.txt',
      'powershell -c "Get-ChildItem C:\\temp"',
      'powershell -c "Remove-Item C:\\temp\\one-file.txt"',
      'powershell -c Get-ChildItem C:\\temp',
      'powershell -c Remove-Item C:\\temp\\one-file.txt',
      'cmd /c "echo hello"',
      'ls -la',
      'rm -rf ./build',
    ]) {
      expect(blocked(c), c).toBe(false);
    }
  });
});
