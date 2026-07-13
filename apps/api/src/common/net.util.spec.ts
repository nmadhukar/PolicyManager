import { hostOf, isPrivateOrLoopbackHost } from './net.util';

describe('net.util', () => {
  describe('hostOf', () => {
    it('extracts a lower-cased hostname', () => {
      expect(hostOf('http://Localhost:8080/cache/x')).toBe('localhost');
      expect(hostOf('https://Docs.Example.COM/y')).toBe('docs.example.com');
    });
    it('strips IPv6 brackets and returns null on garbage', () => {
      expect(hostOf('http://[::1]:9000/x')).toBe('::1');
      expect(hostOf('not a url')).toBeNull();
    });
  });

  describe('isPrivateOrLoopbackHost', () => {
    it.each([
      'localhost',
      'app.localhost',
      'host.docker.internal',
      '127.0.0.1',
      '10.0.0.5',
      '172.16.4.9',
      '172.31.255.1',
      '192.168.1.10',
      '169.254.169.254', // cloud metadata
      '::1',
      'fd00::1',
      'fe80::1',
      '0.0.0.0',
    ])('flags private/loopback %s', (h) => {
      expect(isPrivateOrLoopbackHost(h)).toBe(true);
    });

    it.each(['8.8.8.8', 'docs.example.com', '172.15.0.1', '172.32.0.1', '11.0.0.1'])(
      'allows public %s',
      (h) => {
        expect(isPrivateOrLoopbackHost(h)).toBe(false);
      },
    );
  });
});
