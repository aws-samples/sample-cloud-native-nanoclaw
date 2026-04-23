import { describe, it, expect } from 'vitest';
import {
  parseSlashCommand,
  replyUnknown,
  REPLY_HELP,
} from '../sqs/slash-commands.js';

describe('parseSlashCommand', () => {
  describe('dispatcher commands', () => {
    it.each([
      ['/clear', 'clear'],
      ['/reset', 'reset'],
      ['/new', 'new'],
      ['/help', 'help'],
    ])('%s → dispatcher/%s', (input, command) => {
      expect(parseSlashCommand(input)).toEqual({ kind: 'dispatcher', command, args: '' });
    });

    it('is case-insensitive', () => {
      expect(parseSlashCommand('/CLEAR')).toEqual({ kind: 'dispatcher', command: 'clear', args: '' });
      expect(parseSlashCommand('/Reset')).toEqual({ kind: 'dispatcher', command: 'reset', args: '' });
    });

    it('trims surrounding whitespace', () => {
      expect(parseSlashCommand('  /clear  ')).toEqual({ kind: 'dispatcher', command: 'clear', args: '' });
      expect(parseSlashCommand('\n/help\n')).toEqual({ kind: 'dispatcher', command: 'help', args: '' });
    });

    it('captures args after whitespace', () => {
      expect(parseSlashCommand('/help me out')).toEqual({
        kind: 'dispatcher',
        command: 'help',
        args: 'me out',
      });
    });
  });

  describe('sdk pass-through commands', () => {
    it.each([
      ['/context', 'context'],
      ['/compact', 'compact'],
    ])('%s → sdk/%s', (input, command) => {
      expect(parseSlashCommand(input)).toEqual({ kind: 'sdk', command, args: '' });
    });

    it('captures args for sdk commands', () => {
      expect(parseSlashCommand('/context what is in memory')).toEqual({
        kind: 'sdk',
        command: 'context',
        args: 'what is in memory',
      });
    });
  });

  describe('unknown slash-shaped inputs', () => {
    it('returns unknown for words not in any allowlist', () => {
      expect(parseSlashCommand('/foobar')).toEqual({ kind: 'unknown', command: 'foobar', args: '' });
      expect(parseSlashCommand('/deploy prod')).toEqual({ kind: 'unknown', command: 'deploy', args: 'prod' });
    });
  });

  describe('paths and non-command inputs (kind: none)', () => {
    it.each([
      '/tmp/foo.log',
      '/tmp/',
      '/home/node/.claude',
      '/usr/bin/env',
      '/a/b',
    ])('path %s is not a command', (input) => {
      expect(parseSlashCommand(input)).toEqual({ kind: 'none' });
    });

    it('returns none for bare slash', () => {
      expect(parseSlashCommand('/')).toEqual({ kind: 'none' });
    });

    it('returns none when not anchored at start', () => {
      expect(parseSlashCommand('hello /clear')).toEqual({ kind: 'none' });
      expect(parseSlashCommand('please /help')).toEqual({ kind: 'none' });
    });

    it('returns none for empty / plain text', () => {
      expect(parseSlashCommand('')).toEqual({ kind: 'none' });
      expect(parseSlashCommand('   ')).toEqual({ kind: 'none' });
      expect(parseSlashCommand('hello world')).toEqual({ kind: 'none' });
    });

    it('returns none when command name starts with a digit or symbol', () => {
      expect(parseSlashCommand('/1foo')).toEqual({ kind: 'none' });
      expect(parseSlashCommand('/-flag')).toEqual({ kind: 'none' });
    });

    it('returns none when command name exceeds 64 chars (no log/reply amplification)', () => {
      const long = '/' + 'a'.repeat(65);
      expect(parseSlashCommand(long)).toEqual({ kind: 'none' });
    });

    it('still parses command names up to 64 chars', () => {
      const atLimit = '/' + 'a'.repeat(64);
      expect(parseSlashCommand(atLimit)).toEqual({ kind: 'unknown', command: 'a'.repeat(64), args: '' });
    });
  });

  describe('helpers', () => {
    it('replyUnknown formats as expected', () => {
      expect(replyUnknown('foobar')).toBe('不支持的命令: /foobar');
    });

    it('REPLY_HELP lists all user-visible commands', () => {
      expect(REPLY_HELP).toContain('/clear');
      expect(REPLY_HELP).toContain('/reset');
      expect(REPLY_HELP).toContain('/new');
      expect(REPLY_HELP).toContain('/help');
      expect(REPLY_HELP).toContain('/context');
      expect(REPLY_HELP).toContain('/compact');
    });
  });
});
