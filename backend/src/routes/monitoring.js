import { Router } from 'express';
import { alertingService } from '../monitoring/alerting.js';
import { incidentDetector } from '../jobs/incident-detection.js';
import { incidentStore } from '../monitoring/incident-store.js';
import { z } from 'zod';
import { requireAdminBearerOrRole } from '../middleware/rbac.js';
import { validate } from '../validation.js';

export const monitoringRouter = Router();

const createIncidentSchema = z.object({
  title: z.string().min(1).max(200),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  status: z.enum(['open', 'investigating', 'resolved']).optional(),
  description: z.string().max(2000).optional(),
});

monitoringRouter.get('/alerts', _req => {
  return alertingService.getActiveAlerts();
});

monitoringRouter.get('/incidents', _req => {
  return incidentStore.list();
});

monitoringRouter.get('/incidents/:id', (req) => {
  const incident = incidentStore.get(req.params.id);
  if (!incident) {
    req.res.status(404);
    return { error: 'not found' };
  }
  return incident;
});

monitoringRouter.post(
  '/incidents',
  requireAdminBearerOrRole('operator'),
  validate(createIncidentSchema),
  (req, res) => {
    const incident = incidentStore.create(req.body);
    return res.status(201).json(incident);
  }
);

monitoringRouter.patch('/incidents/:id', (req) => {
  const updated = incidentStore.update(req.params.id, req.body || {});
  if (!updated) {
    req.res.status(404);
    return { error: 'not found' };
  }
  return updated;
});

monitoringRouter.get('/metrics/summary', _req => {
  return incidentStore.metricsSummary();
});
