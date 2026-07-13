import { BadRequestException, ConflictException } from '@nestjs/common';
import { StorageAdminService } from './storage-admin.service';

const makeS3 = () => ({
  getStorageConfig: jest.fn().mockReturnValue({
    bucket: 'policymanager-docs',
    prefixes: { documents: 'documents/', renditions: 'renditions/' },
    endpoint: 'http://localhost:9000',
    region: 'us-east-2',
  }),
  listBuckets: jest.fn().mockResolvedValue([
    { name: 'policymanager-docs', createdAt: null, isDefault: true },
  ]),
  createBucket: jest.fn().mockResolvedValue({
    name: 'new-bucket',
    createdAt: '2026-07-12T00:00:00.000Z',
    isDefault: false,
  }),
  listPrefixes: jest.fn().mockResolvedValue([{ prefix: 'policies/' }]),
  createFolder: jest.fn().mockResolvedValue({ prefix: 'intake/' }),
});

const build = (s = makeS3()) => ({ s3: s, svc: new StorageAdminService(s as never) });

describe('StorageAdminService.getConfig / listBuckets', () => {
  it('returns the effective config and bucket list', async () => {
    const { svc } = build();
    expect(svc.getConfig().bucket).toBe('policymanager-docs');
    const buckets = await svc.listBuckets();
    expect(buckets[0].isDefault).toBe(true);
  });
});

describe('StorageAdminService.createBucket', () => {
  it('creates a valid bucket (private + versioned enforced by the gateway)', async () => {
    const { svc, s3 } = build();
    const bucket = await svc.createBucket('new-bucket');
    expect(s3.createBucket).toHaveBeenCalledWith('new-bucket');
    expect(bucket.name).toBe('new-bucket');
  });

  it('rejects an invalid bucket name with 400 (no S3 call)', async () => {
    const { svc, s3 } = build();
    await expect(svc.createBucket('Bad_Name')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createBucket('ab')).rejects.toBeInstanceOf(BadRequestException);
    expect(s3.createBucket).not.toHaveBeenCalled();
  });

  it('maps an already-exists error to 409 Conflict', async () => {
    const s3 = makeS3();
    s3.createBucket.mockRejectedValue(Object.assign(new Error('exists'), {
      name: 'BucketAlreadyOwnedByYou',
    }));
    const { svc } = build(s3);
    await expect(svc.createBucket('taken-bucket')).rejects.toBeInstanceOf(ConflictException);
  });

  it('rethrows unexpected S3 errors', async () => {
    const s3 = makeS3();
    s3.createBucket.mockRejectedValue(new Error('network down'));
    const { svc } = build(s3);
    await expect(svc.createBucket('good-bucket')).rejects.toThrow('network down');
  });
});

describe('StorageAdminService.listPrefixes / createFolder', () => {
  it('lists prefixes for a bucket', async () => {
    const { svc, s3 } = build();
    const prefixes = await svc.listPrefixes('policymanager-docs', 'policies/');
    expect(s3.listPrefixes).toHaveBeenCalledWith('policymanager-docs', 'policies/');
    expect(prefixes).toEqual([{ prefix: 'policies/' }]);
  });

  it('requires a bucket for listing', async () => {
    const { svc } = build();
    await expect(svc.listPrefixes('')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates a folder marker for a valid name', async () => {
    const { svc, s3 } = build();
    await svc.createFolder('policymanager-docs', 'intake');
    expect(s3.createFolder).toHaveBeenCalledWith('policymanager-docs', 'intake');
  });

  it('rejects an empty/unsafe folder name with 400 (no S3 call)', async () => {
    const { svc, s3 } = build();
    await expect(svc.createFolder('policymanager-docs', '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.createFolder('policymanager-docs', '..')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(s3.createFolder).not.toHaveBeenCalled();
  });
});
