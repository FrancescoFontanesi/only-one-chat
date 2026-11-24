// The closed list of destructive commands (ADR 0050): what is never approved
// "for the session", and what must not be mistaken for it.

import { describe, expect, it } from 'vitest';
import { isDestructiveCommand, isDestructiveRequest } from '../src/index.js';

describe('destructive commands', () => {
  it.each([
    'rm -rf build',
    'rmdir /s /q out',
    'del /f notes.txt',
    'erase old.log',
    'Remove-Item -Recurse dist',
    'Clear-Content log.txt',
    'shred -u secrets',
    'unlink a.txt',
    'format D:',
    'git push --force origin main',
    'git push -f',
    'git push --force-with-lease',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git checkout -- src/a.ts',
    'git restore src/a.ts',
    'git branch -D topic',
    'git rebase -i main',
    'git filter-branch --tree-filter x',
    'git filter-repo --path a',
    'chmod 777 run.sh',
    'chown root file',
    'icacls C:\\x /grant Everyone:F',
    'takeown /f C:\\x',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sdb1',
    'diskpart',
    'reg delete HKCU\\Software\\X /f',
    'Stop-Process -Name node',
    'kill -9 1234',
    'taskkill /F /IM node.exe',
    'psql -c "DROP TABLE users"',
    'sqlite3 db "drop database prod"',
    'DROP SCHEMA public CASCADE',
    'TRUNCATE TABLE logs',
    'npm publish',
    'pnpm publish --access public',
    // After a separator, a quote, or a wrapper that runs it.
    'cd build && rm -rf *',
    'npm test; rm out.txt',
    '"C:\\WINDOWS\\powershell.exe" -Command \'Remove-Item -LiteralPath a.txt\'',
    'powershell -Command Remove-Item a.txt',
    'cmd /c del a.txt',
    'sudo rm /etc/hosts',
    'bash -c "rm -rf x"',
    'find . -name "*.o" | xargs rm',
    'RM -RF build',
  ])('%s is destructive', (command) => {
    expect(isDestructiveCommand(command)).toBe(true);
  });

  it.each([
    'git status',
    'git push origin main',
    'git push -u origin topic',
    'git branch -d merged',
    'git checkout main',
    'git log --format=%H',
    'python -m unittest',
    'format_price(10)',
    'delete_temp_var = None',
    'npm run format',
    'pnpm format',
    'prettier --check .',
    'python rmdir2.py',
    'ls -la',
    'npm install',
    'cat drop_table.sql',
    'echo kill switch',
    'grep -r "format" src',
  ])('%s is not', (command) => {
    expect(isDestructiveCommand(command)).toBe(false);
  });

  it('reads a shell tool’s command, else the summary after the tool’s name', () => {
    expect(isDestructiveRequest('Bash', { command: 'rm -rf x' }, 'Bash: rm -rf x')).toBe(true);
    expect(isDestructiveRequest('Bash', { command: 'git status' }, 'Bash: rm -rf x')).toBe(false);
    expect(isDestructiveRequest('Edit', { file_path: 'rm.txt' }, 'Edit: rm.txt')).toBe(false);
    expect(isDestructiveRequest('PowerShell', {}, 'PowerShell: Remove-Item a')).toBe(true);
  });
});
