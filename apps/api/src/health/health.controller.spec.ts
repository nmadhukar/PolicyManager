import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok status', () => {
    const controller = new HealthController();
    const result = controller.check();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('policymanager-api');
    expect(typeof result.timestamp).toBe('string');
  });
});
