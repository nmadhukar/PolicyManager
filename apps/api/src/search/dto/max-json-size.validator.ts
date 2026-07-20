import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * FINDING-017: UpsertSavedSearchDto.filters/.sort accept `@IsObject()` with no
 * size bound — a caller with write access could persist a multi-megabyte JSON
 * blob per saved search (stored in a Postgres `Json` column, re-fetched and
 * re-serialized on every list/run). Bounds the serialized JSON size instead of
 * changing the accepted shape (still any object; just capped).
 */
export function MaxJsonSize(maxBytes: number, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'maxJsonSize',
      target: object.constructor,
      propertyName,
      constraints: [maxBytes],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          if (value === undefined || value === null) return true; // @IsOptional handles absence
          let size: number;
          try {
            size = Buffer.byteLength(JSON.stringify(value), 'utf8');
          } catch {
            return false; // circular or non-serializable — reject
          }
          const [limit] = args.constraints as [number];
          return size <= limit;
        },
        defaultMessage(args: ValidationArguments) {
          const [limit] = args.constraints as [number];
          return `${args.property} must not exceed ${limit} bytes when serialized as JSON`;
        },
      },
    });
  };
}
