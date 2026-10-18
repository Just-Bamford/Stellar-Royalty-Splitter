import { Router } from 'express';
import { alertingService } from '../monitoring/alerting.js';
import { incidentDetector } from '../jobs/incident-detection.js';
import { incidentStore } from '../monitoring/incident-store.js';

export const monitoringRouter = Router();

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

monitoringRouter.post('/incidents', (req) => {
  const incident = incidentStore.create(req.body || {});
  req.res.status(201);
  return incident;
});

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
