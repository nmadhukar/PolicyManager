import { S3Client } from '@aws-sdk/client-s3';
import { S3Service } from './s3.service';

describe('S3Service bootstrap safety', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('applies block-public-access when auto-provisioning the default bucket', async () => {
    const sent: string[] = [];
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: object) => {
      sent.push(command.constructor.name);
      return {};
    });
    const config = {
      get: (key: string) =>
        ({
          S3_ENDPOINT: 'http://127.0.0.1:9000',
          S3_AUTO_CREATE: 'true',
          S3_BUCKET: 'policymanager-docs',
        })[key],
    };

    await new S3Service(config as never).onModuleInit();

    expect(sent).toEqual(
      expect.arrayContaining([
        'HeadBucketCommand',
        'PutBucketVersioningCommand',
        'PutPublicAccessBlockCommand',
      ]),
    );
  });

  it('rejects default MinIO credentials for non-local private endpoints', () => {
    const config = {
      get: (key: string) =>
        ({
          S3_ENDPOINT: 'http://10.0.0.25:9000',
          S3_BUCKET: 'policymanager-docs',
        })[key],
    };

    expect(() => new S3Service(config as never)).toThrow(/S3_ACCESS_KEY_ID/);
  });
});
