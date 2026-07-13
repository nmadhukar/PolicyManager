import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import * as authApi from '../api/auth';

describe('ForgotPasswordPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows a neutral confirmation after submitting (no account enumeration)', async () => {
    const spy = vi.spyOn(authApi, 'apiForgotPassword').mockResolvedValue();
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ghost@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() =>
      expect(screen.getByText(/if an account exists for/i)).toBeInTheDocument(),
    );
    expect(spy).toHaveBeenCalledWith('ghost@x.com');
  });

  it('surfaces a generic error when the request fails', async () => {
    vi.spyOn(authApi, 'apiForgotPassword').mockRejectedValue(new Error('network'));
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
