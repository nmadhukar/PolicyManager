import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { ResetPasswordPage } from './ResetPasswordPage';
import * as authApi from '../api/auth';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/login" element={<div>LOGIN PAGE</div>} />
        <Route path="/forgot-password" element={<div>FORGOT PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ResetPasswordPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows an error when the link has no token', () => {
    renderAt('/reset-password');
    expect(screen.getByText(/missing its token/i)).toBeInTheDocument();
  });

  it('resets the password and redirects to login on success', async () => {
    const spy = vi.spyOn(authApi, 'apiResetPassword').mockResolvedValue();
    renderAt('/reset-password?token=TOK123');

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'Str0ngPass' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'Str0ngPass' },
    });
    fireEvent.click(screen.getByRole('button', { name: /set new password/i }));

    await waitFor(() => expect(screen.getByText('LOGIN PAGE')).toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith('TOK123', 'Str0ngPass');
  });

  it('blocks submit while the confirmation does not match', () => {
    const spy = vi.spyOn(authApi, 'apiResetPassword').mockResolvedValue();
    renderAt('/reset-password?token=TOK123');

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'Str0ngPass' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'Different1' },
    });

    expect(screen.getByText(/do not match/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set new password/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /set new password/i }));
    expect(spy).not.toHaveBeenCalled();
  });
});
