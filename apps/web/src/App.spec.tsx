import { render, screen } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('renders the welcome heading and brand', () => {
    render(<App />);
    expect(screen.getByText('Welcome to PolicyManager')).toBeInTheDocument();
    expect(screen.getByText('PolicyManager')).toBeInTheDocument();
  });
});
