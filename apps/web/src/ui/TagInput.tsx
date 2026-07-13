import { KeyboardEvent, useState } from 'react';

/**
 * Accessible chip input for a string[] value. Enter or comma commits a tag;
 * Backspace on an empty field removes the last; each chip has a labeled remove
 * button. Duplicates and blanks are ignored.
 */
export function TagInput({
  value,
  onChange,
  ariaLabel,
  placeholder = 'Add a tag and press Enter',
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  const add = (raw: string) => {
    const tag = raw.trim();
    if (!tag || value.includes(tag)) {
      setDraft('');
      return;
    }
    onChange([...value, tag]);
    setDraft('');
  };

  const remove = (tag: string) => onChange(value.filter((t) => t !== tag));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      remove(value[value.length - 1]);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 p-2 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-100">
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"
        >
          {tag}
          <button
            type="button"
            className="text-brand-500 hover:text-brand-700"
            onClick={() => remove(tag)}
            aria-label={`Remove tag ${tag}`}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        className="min-w-[8rem] flex-1 border-none p-0.5 text-sm outline-none placeholder:text-ink-muted"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(draft)}
        placeholder={value.length === 0 ? placeholder : ''}
        aria-label={ariaLabel}
      />
    </div>
  );
}
