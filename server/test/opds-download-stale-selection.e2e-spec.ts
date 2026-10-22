import { randomUUID } from 'crypto';
import { appendFile, stat } from 'fs/promises';

import { Permission } from '@bookorbit/types';
import { eq } from 'drizzle-orm';

import * as schema from '../src/db/schema';
import { createEpubFixture } from './e2e/opds/opds-fixture-builder';
import {
  basicAuth,
  closeOpdsE2EContext,
  createLibraryWithFolder,
  createOpdsE2EContext,
  createOpdsUserCredential,
  createUserAndLogin,
  grantLibraryAccess,
  locateBookByAbsolutePath,
  triggerAndWaitForLibraryScan,
  type OpdsE2EContext,
} from './e2e/opds/opds-harness';

/**
 * Issue #1810: an OPDS client downloads from a catalog rendered before the
 * server embedded metadata into the EPUB. The write bumps the file's
 * contentVersion, which must not turn every previously issued download link
 * into a 409.
 */
describe('OPDS download with a superseded selection descriptor (e2e)', { timeout: 120_000 }, () => {
  let ctx!: OpdsE2EContext;

  afterAll(async () => {
    if (ctx) await closeOpdsE2EContext(ctx);
  });

  it('serves the current bytes through a catalog link rendered before a metadata write', async () => {
    ctx = await createOpdsE2EContext();
    const library = await createLibraryWithFolder(ctx, { name: `opds-stale-selection-${randomUUID()}` });
    const epubPath = await createEpubFixture(library.folderPath, 'stale-selection.epub', { title: 'Stale Selection' });
    await triggerAndWaitForLibraryScan(ctx, library.libraryId);
    const book = await locateBookByAbsolutePath(ctx, epubPath);

    const owner = await createUserAndLogin(ctx, { permissions: [Permission.OpdsAccess] });
    await grantLibraryAccess(ctx, owner.userId, library.libraryId, 'viewer');
    const opds = await createOpdsUserCredential(ctx, { userId: owner.userId, password: 'StaleSelection123' });
    const auth = { authorization: basicAuth(opds.row.username, opds.password) };

    const acquisitionHref = async (): Promise<string> => {
      const catalog = await ctx.app.inject({ method: 'GET', url: '/api/v1/opds/catalog', headers: auth });
      expect(catalog.statusCode).toBe(200);
      const href = [...catalog.body.matchAll(/href="([^"]*\/download[^"]*)"/g)]
        .map((match) => match[1].replaceAll('&amp;', '&'))
        .find((href) => href.includes(`fileId=${book.bookFileId}`));
      expect(href).toBeTruthy();
      return href!;
    };

    // The link is captured before the write, exactly like a client's cached catalog.
    const staleHref = await acquisitionHref();
    const before = await ctx.app.inject({ method: 'GET', url: staleHref, headers: auth });
    expect(before.statusCode).toBe(200);

    // Mirror updateFileStateAfterMetadataWrite: the file changes on disk and the
    // row gets the fresh stat fields plus a bumped contentVersion (updatedAt).
    await appendFile(epubPath, 'embedded-metadata');
    const written = await stat(epubPath);
    await ctx.db
      .update(schema.bookFiles)
      .set({ mtime: written.mtime, sizeBytes: Number(written.size), ino: written.ino, updatedAt: new Date() })
      .where(eq(schema.bookFiles.id, book.bookFileId));

    const after = await ctx.app.inject({ method: 'GET', url: staleHref, headers: auth });
    expect(after.statusCode).toBe(200);
    expect(after.rawPayload.length).toBe(before.rawPayload.length + 'embedded-metadata'.length);
    expect(after.rawPayload.subarray(-'embedded-metadata'.length).toString()).toBe('embedded-metadata');

    const fresh = await ctx.app.inject({ method: 'GET', url: await acquisitionHref(), headers: auth });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.rawPayload).toEqual(after.rawPayload);

    // A superseded descriptor still authorizes nothing on its own: the
    // account/scope/file/variant binding and book access are enforced live.
    const otherPath = await createEpubFixture(library.folderPath, 'other-book.epub', { title: 'Other Book' });
    await triggerAndWaitForLibraryScan(ctx, library.libraryId);
    const other = await locateBookByAbsolutePath(ctx, otherPath);
    const wrongFile = await ctx.app.inject({
      method: 'GET',
      url: staleHref.replace(`fileId=${book.bookFileId}`, `fileId=${other.bookFileId}`).replace(/\/opds\/\d+\//, `/opds/${other.bookId}/`),
      headers: auth,
    });
    expect(wrongFile.statusCode).toBe(403);

    await ctx.db.delete(schema.opdsUsers).where(eq(schema.opdsUsers.id, opds.row.id));
    const deletedCredential = await ctx.app.inject({ method: 'GET', url: staleHref, headers: auth });
    expect(deletedCredential.statusCode).toBe(401);

    const second = await createOpdsUserCredential(ctx, { userId: owner.userId, password: 'StaleSelection456' });
    const secondAuth = { authorization: basicAuth(second.row.username, second.password) };
    await ctx.db.delete(schema.userLibraryAccess).where(eq(schema.userLibraryAccess.userId, owner.userId));
    const revokedAccess = await ctx.app.inject({ method: 'GET', url: staleHref, headers: secondAuth });
    expect([403, 404]).toContain(revokedAccess.statusCode);
  });
});
