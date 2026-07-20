import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpsertSavedSearchDto } from './upsert-saved-search.dto';

/**
 * FINDING-017: filters/sort previously had no size bound (@IsObject() only
 * checks the type, not the size), so a caller with document.write access
 * could persist an arbitrarily large JSON blob per saved search.
 */
describe('UpsertSavedSearchDto (FINDING-017: filters/sort size bound)', () => {
  function dto(over: Record<string, unknown> = {}) {
    return plainToInstance(UpsertSavedSearchDto, {
      name: 'My search',
      filters: { status: 'published' },
      ...over,
    });
  }

  it('accepts normal, small filters/sort objects', async () => {
    const errors = await validate(dto({ sort: { field: 'title', direction: 'asc' } }));
    expect(errors).toHaveLength(0);
  });

  it('rejects filters exceeding the size bound', async () => {
    const huge = { blob: 'x'.repeat(60_000) }; // > 50,000-byte cap once serialized
    const errors = await validate(dto({ filters: huge }));
    const filtersError = errors.find((e) => e.property === 'filters');
    expect(filtersError).toBeDefined();
    expect(Object.values(filtersError!.constraints ?? {})).toEqual([
      expect.stringContaining('must not exceed'),
    ]);
  });

  it('rejects sort exceeding the size bound', async () => {
    const huge = { blob: 'x'.repeat(60_000) };
    const errors = await validate(dto({ sort: huge }));
    const sortError = errors.find((e) => e.property === 'sort');
    expect(sortError).toBeDefined();
  });

  it('still allows sort to be omitted (optional)', async () => {
    const errors = await validate(dto());
    expect(errors).toHaveLength(0);
  });
});
