import { API_SCOPES_KEY } from '../api-clients/require-scope.decorator';
import { PublicDocumentsController } from './public-documents.controller';

describe('PublicDocumentsController scope metadata', () => {
  it('requires content scope for search because search returns extracted-text snippets', () => {
    const scopes = Reflect.getMetadata(API_SCOPES_KEY, PublicDocumentsController.prototype.search);
    expect(scopes).toEqual(['documents:read', 'content:read']);
  });
});
