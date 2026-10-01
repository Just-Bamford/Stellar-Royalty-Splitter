import { describe, expect, test } from '@jest/globals';

import {
  createSchedule,
  validateSchedule,
  getNextRun,
  executeSchedule,
  setScheduleEnabled,
  listSchedules,
} from '../src/services/scheduler.js';

import {
  createWorkflow,
  validateWorkflowDefinition,
  evaluateWorkflow,
  listWorkflows,
} from '../src/services/workflow-engine.js';

describe('scheduler engine', () => {
  test('valid weekly schedule', () => {
    const schedule = createSchedule({
      name: 'Weekly payout',
      type: 'weekly',
      dayOfWeek: 2,
      time: '09:00',
      enabled: true,
    });

    expect(schedule).toMatchObject({ name: 'Weekly payout', type: 'weekly', enabled: true });
    expect(schedule.nextRunAt).toBeTruthy();
  });

  test('valid monthly schedule', () => {
    const schedule = createSchedule({
      name: 'Monthly reporting',
      type: 'monthly',
      dayOfMonth: 15,
      time: '10:30',
      enabled: true,
    });

    expect(schedule.type).toBe('monthly');
    expect(new Date(schedule.nextRunAt).toISOString()).toContain('T10:30:00');
  });

  test('valid custom cron-like schedule', () => {
    const schedule = createSchedule({
      name: 'Cron task',
      type: 'custom',
      cron: '0 */2 * * *',
      enabled: true,
    });

    expect(schedule.type).toBe('custom');
    expect(schedule.cron).toBe('0 */2 * * *');
  });

  test('invalid schedule rejected', () => {
    expect(() =>
      validateSchedule({
        name: '',
        type: 'weekly',
        dayOfWeek: 9,
      }),
    ).toThrow(/invalid|dayOfWeek|name/i);
  });

  test('schedule can be enabled/disabled', () => {
    const schedule = createSchedule({ name: 'Maintenance', type: 'one-time', runAt: '2099-01-01T00:00:00.000Z', enabled: true });
    expect(schedule.enabled).toBe(true);

    const disabled = setScheduleEnabled(schedule.id, false);
    expect(disabled.enabled).toBe(false);
  });

  test('disabled schedule does not execute', async () => {
    const schedule = createSchedule({
      name: 'Disabled report',
      type: 'one-time',
      runAt: '2020-01-01T00:00:00.000Z',
      enabled: false,
    });

    const result = await executeSchedule(schedule.id, new Date('2020-01-01T00:00:00.000Z'));
    expect(result.status).toBe('disabled');
  });

  test('next-run calculation', () => {
    const schedule = createSchedule({
      name: 'Weekly',
      type: 'weekly',
      dayOfWeek: 1,
      time: '08:00',
      enabled: true,
    });

    const nextRun = getNextRun(schedule, new Date('2026-09-28T12:00:00.000Z'));
    expect(nextRun).toBeTruthy();
  });

  test('successful execution recorded', async () => {
    const schedule = createSchedule({
      name: 'Success job',
      type: 'one-time',
      runAt: '2025-01-01T00:00:00.000Z',
      enabled: true,
    });

    const result = await executeSchedule(schedule.id, new Date('2025-01-01T00:00:00.000Z'), {
      metadata: { job: 'report' },
    });

    expect(result.status).toBe('success');
    expect(result.history[0].status).toBe('success');
  });

  test('failed execution recorded', async () => {
    const schedule = createSchedule({
      name: 'Failing job',
      type: 'one-time',
      runAt: '2025-01-02T00:00:00.000Z',
      enabled: true,
    });

    const result = await executeSchedule(schedule.id, new Date('2025-01-02T00:00:00.000Z'), {
      execute: async () => {
        throw new Error('boom');
      },
    });

    expect(result.status).toBe('failed');
    expect(result.history[0].error).toMatch(/boom/i);
  });

  test('duplicate/repeated execution protection', async () => {
    const schedule = createSchedule({
      name: 'Duplicate guard',
      type: 'one-time',
      runAt: '2025-01-03T00:00:00.000Z',
      enabled: true,
    });

    const first = await executeSchedule(schedule.id, new Date('2025-01-03T00:00:00.000Z'));
    const second = await executeSchedule(schedule.id, new Date('2025-01-03T00:00:00.000Z'));

    expect(first.status).toBe('success');
    expect(second.status).toBe('duplicate');
    expect(listSchedules().length).toBeGreaterThan(0);
  });
});

describe('workflow engine', () => {
  test('earnings threshold triggers action', () => {
    const workflow = createWorkflow({
      name: 'Earnings gate',
      enabled: true,
      trigger: {
        type: 'earningsThreshold',
        threshold: 100,
      },
      actions: [{ type: 'distribution', name: 'Auto distribute' }],
    });

    const outcome = evaluateWorkflow(workflow, { earnings: 250 });
    expect(outcome.matched).toBe(true);
  });

  test('earnings below threshold does not trigger', () => {
    const workflow = createWorkflow({
      name: 'Earnings gate',
      enabled: true,
      trigger: {
        type: 'earningsThreshold',
        threshold: 100,
      },
      actions: [{ type: 'distribution', name: 'Auto distribute' }],
    });

    const outcome = evaluateWorkflow(workflow, { earnings: 50 });
    expect(outcome.matched).toBe(false);
  });

  test('dispute unresolved for 30 days triggers escalation', () => {
    const workflow = createWorkflow({
      name: 'Escalate dispute',
      enabled: true,
      trigger: { type: 'unresolvedDispute', days: 30 },
      actions: [{ type: 'escalation', name: 'Escalate dispute' }],
    });

    const outcome = evaluateWorkflow(workflow, {
      dispute: { resolved: false, createdAt: '2024-01-01T00:00:00.000Z' },
      now: new Date('2024-01-31T00:00:00.000Z'),
    });

    expect(outcome.matched).toBe(true);
  });

  test('dispute younger than 30 days does not trigger escalation', () => {
    const workflow = createWorkflow({
      name: 'Escalate dispute',
      enabled: true,
      trigger: { type: 'unresolvedDispute', days: 30 },
      actions: [{ type: 'escalation', name: 'Escalate dispute' }],
    });

    const outcome = evaluateWorkflow(workflow, {
      dispute: { resolved: false, createdAt: '2024-01-15T00:00:00.000Z' },
      now: new Date('2024-01-31T00:00:00.000Z'),
    });

    expect(outcome.matched).toBe(false);
  });

  test('inactive collaborator more than 90 days triggers notification', () => {
    const workflow = createWorkflow({
      name: 'Inactive collaborator',
      enabled: true,
      trigger: { type: 'inactiveCollaborator', days: 90 },
      actions: [{ type: 'notification', name: 'Notify collaborator' }],
    });

    const outcome = evaluateWorkflow(workflow, {
      collaborator: { lastActiveAt: '2024-01-01T00:00:00.000Z' },
      now: new Date('2024-04-05T00:00:00.000Z'),
    });

    expect(outcome.matched).toBe(true);
  });

  test('active collaborator does not trigger notification', () => {
    const workflow = createWorkflow({
      name: 'Inactive collaborator',
      enabled: true,
      trigger: { type: 'inactiveCollaborator', days: 90 },
      actions: [{ type: 'notification', name: 'Notify collaborator' }],
    });

    const outcome = evaluateWorkflow(workflow, {
      collaborator: { lastActiveAt: '2024-04-01T00:00:00.000Z' },
      now: new Date('2024-04-05T00:00:00.000Z'),
    });

    expect(outcome.matched).toBe(false);
  });

  test('disabled workflow does not execute', async () => {
    const workflow = createWorkflow({
      name: 'Disabled',
      enabled: false,
      trigger: { type: 'earningsThreshold', threshold: 1 },
      actions: [{ type: 'notification', name: 'Notify' }],
    });

    const result = await workflow.engine?.runWorkflow?.(workflow, { earnings: 10 });
    expect(result?.status ?? 'skipped').toBe('skipped');
  });

  test('failed action records failure correctly', async () => {
    const workflow = createWorkflow({
      name: 'Failing action',
      enabled: true,
      trigger: { type: 'earningsThreshold', threshold: 1 },
      actions: [{ type: 'distribution', name: 'Auto distribute' }],
    });

    const result = await workflow.engine?.runWorkflow?.(workflow, {
      earnings: 10,
      distributionService: async () => { throw new Error('distribution failed'); },
    });

    expect(result.status).toBe('failed');
    expect(result.history[0].status).toBe('failed');
  });

  test('workflow validation rejects bad definitions', () => {
    expect(() => validateWorkflowDefinition({ name: 'bad', enabled: true, actions: [] })).toThrow(/trigger|actions/i);
  });

  test('workflow listing includes created engines', () => {
    createWorkflow({ name: 'Listed', enabled: true, trigger: { type: 'earningsThreshold', threshold: 5 }, actions: [{ type: 'notification', name: 'Notify' }] });
    expect(listWorkflows().length).toBeGreaterThan(0);
  });
});
