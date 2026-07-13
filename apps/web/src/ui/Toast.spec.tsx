import { fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast';

function ErrorTrigger() {
  const toast = useToast();
  return (
    <button onClick={() => toast.error('Could not save your change.')}>trigger</button>
  );
}

describe('Toast system (FH3)', () => {
  it('renders an error toast with role="alert" and dismisses it', () => {
    render(
      <ToastProvider>
        <ErrorTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not save your change.');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Could not save your change.')).not.toBeInTheDocument();
  });

  it('useToast is a safe no-op without a provider (never throws)', () => {
    function Solo() {
      const toast = useToast();
      return <button onClick={() => toast.error('x')}>solo</button>;
    }
    render(<Solo />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'solo' }))).not.toThrow();
  });
});
