import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CategorySelectWithCreate } from './CategorySelectWithCreate';

const mockCreateCategory = vi.fn();

vi.mock('../api/categories', () => ({
  createCategory: (...args: unknown[]) => mockCreateCategory(...args),
}));

function renderPicker(onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <label htmlFor="category">Category</label>
      <CategorySelectWithCreate
        id="category"
        value=""
        categoryOptions={[{ id: 'parent-1', name: 'Policies', depth: 0 }]}
        onChange={onChange}
      />
    </QueryClientProvider>,
  );
  return { onChange };
}

describe('CategorySelectWithCreate', () => {
  beforeEach(() => {
    mockCreateCategory.mockReset().mockResolvedValue({
      id: 'cat-2',
      name: 'Clinical',
      parentId: 'parent-1',
      description: null,
      children: [],
    });
  });

  it('creates a category, selects it, and keeps it available locally', async () => {
    const { onChange } = renderPicker();

    fireEvent.click(screen.getByRole('button', { name: 'New category' }));
    fireEvent.change(screen.getByLabelText(/category name/i), {
      target: { value: 'Clinical' },
    });
    fireEvent.change(screen.getByLabelText('Parent'), {
      target: { value: 'parent-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create category' }));

    await waitFor(() =>
      expect(mockCreateCategory).toHaveBeenCalledWith({
        name: 'Clinical',
        parentId: 'parent-1',
        description: undefined,
      }),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('cat-2'));
    expect(screen.getByRole('option', { name: /Clinical/ })).toBeInTheDocument();
  });

  it('requires a category name before calling the API', () => {
    renderPicker();

    fireEvent.click(screen.getByRole('button', { name: 'New category' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create category' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Category name is required.');
    expect(mockCreateCategory).not.toHaveBeenCalled();
  });
});
