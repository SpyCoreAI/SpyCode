import { describe, expect, test } from 'vitest';
import {
  EXIT_AUTH_ERROR,
  EXIT_NETWORK_ERROR,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  SpycoreCliError,
  isSpycoreCliError,
} from '../src/lib/errors.js';

describe('SpycoreCliError', () => {
  test('exit codes are stable integers', () => {
    expect(EXIT_USER_ERROR).toBe(1);
    expect(EXIT_AUTH_ERROR).toBe(2);
    expect(EXIT_NETWORK_ERROR).toBe(3);
    expect(EXIT_SERVER_ERROR).toBe(4);
  });

  test('default code is USER_ERROR', () => {
    const err = new SpycoreCliError('boom');
    expect(err.code).toBe(EXIT_USER_ERROR);
    expect(err.hint).toBeUndefined();
  });

  test('carries explicit code + hint', () => {
    const err = new SpycoreCliError('auth fail', EXIT_AUTH_ERROR, 'Run login');
    expect(err.code).toBe(EXIT_AUTH_ERROR);
    expect(err.hint).toBe('Run login');
  });

  test('isSpycoreCliError narrows generic Error', () => {
    expect(isSpycoreCliError(new SpycoreCliError('x'))).toBe(true);
    expect(isSpycoreCliError(new Error('x'))).toBe(false);
    expect(isSpycoreCliError('x')).toBe(false);
    expect(isSpycoreCliError(null)).toBe(false);
  });
});
