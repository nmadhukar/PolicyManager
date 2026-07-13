import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Modal } from './Modal';

describe('Modal focus management (FH1) + busy gating (FL2)', () => {
  it('moves focus into the dialog on open', () => {
    render(
      <Modal open onClose={() => undefined} titleId="t">
        <h2 id="t">Title</h2>
        <button>first</button>
        <button>second</button>
      </Modal>,
    );
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} titleId="t">
        <button>x</button>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape and backdrop clicks while busy', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} titleId="t" busy>
        <button>x</button>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    // The backdrop is the outermost element behind the dialog.
    fireEvent.mouseDown(document.querySelector('.fixed.inset-0') as Element);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('traps Tab, wrapping from the last focusable back to the first', () => {
    render(
      <Modal open onClose={() => undefined} titleId="t">
        <button>first</button>
        <button>last</button>
      </Modal>,
    );
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();
  });

  it('restores focus to the previously-focused element on close', () => {
    function Wrap() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          <Modal open={open} onClose={() => setOpen(false)} titleId="t">
            <button>inside</button>
          </Modal>
        </>
      );
    }
    render(<Wrap />);
    const trigger = screen.getByRole('button', { name: 'open' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'inside' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveFocus();
  });
});
