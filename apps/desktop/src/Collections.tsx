import { useCallback, useMemo, useState } from 'react';
import type { Collection, Comic } from '@longbox/core';
import { ComicCard } from './ComicCard.tsx';

/**
 * Hand-made lists: a reading queue, a re-read, a pile to get to.
 *
 * Order is meaningful, so membership is a list rather than a set and new comics
 * are appended. Removing a comic from a collection never touches the comic.
 */

function newCollectionId(): string {
  // Collections are user-made and have no natural key, so an id is minted here
  // rather than derived. Import treats a clash as the same collection, so the
  // value has to be unlikely to repeat across machines.
  return `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function CollectionsView({
  collections,
  comics,
  openId,
  onOpen,
  onChanged,
  onOpenComic,
}: {
  collections: Collection[];
  comics: Comic[];
  openId?: string;
  onOpen: (id: string | undefined) => void;
  onChanged: () => void;
  onOpenComic: (comic: Comic) => void;
}) {
  const [draftName, setDraftName] = useState('');
  const [renaming, setRenaming] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');

  const byId = useMemo(() => new Map(comics.map((comic) => [comic.id, comic])), [comics]);
  const open = collections.find((collection) => collection.id === openId);

  const create = useCallback(async () => {
    const name = draftName.trim();
    if (!name) return;
    await window.longbox.saveCollection({
      id: newCollectionId(),
      name,
      comicIds: [],
      createdAt: Date.now(),
    });
    setDraftName('');
    onChanged();
  }, [draftName, onChanged]);

  const commitRename = useCallback(
    async (collection: Collection) => {
      const name = renameDraft.trim();
      setRenaming(undefined);
      if (!name || name === collection.name) return;
      await window.longbox.saveCollection({ ...collection, name });
      onChanged();
    },
    [renameDraft, onChanged],
  );

  const remove = useCallback(
    async (collection: Collection) => {
      await window.longbox.removeCollection(collection.id);
      if (openId === collection.id) onOpen(undefined);
      onChanged();
    },
    [openId, onOpen, onChanged],
  );

  if (open) {
    // Missing ids are skipped rather than shown as gaps: a comic can be removed
    // from the library while a collection still lists it.
    const members = open.comicIds
      .map((id) => byId.get(id))
      .filter((comic): comic is Comic => comic !== undefined);

    return (
      <div className="panel wide">
        <section>
          <div className="collection-head">
            <button className="btn" onClick={() => onOpen(undefined)}>
              ← Collections
            </button>
            <h2>{open.name}</h2>
            <span className="hint" style={{ margin: 0 }}>
              {members.length} {members.length === 1 ? 'comic' : 'comics'}
            </span>
          </div>

          {members.length === 0 ? (
            <p className="hint">
              Nothing here yet. Add comics from the library with the <b>+</b> on a cover.
            </p>
          ) : (
            <div className="grid">
              {members.map((comic) => (
                <ComicCard
                  key={comic.id}
                  comic={comic}
                  onOpen={onOpenComic}
                  collections={collections}
                  onCollectionsChanged={onChanged}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="panel wide">
      <section>
        <h2>Collections</h2>
        <p className="hint">
          Ordered lists you make by hand — a reading queue, a re-read, anything. Removing a comic
          from a collection leaves the comic and its file alone.
        </p>

        <div className="folder-row">
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="New collection name"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create();
            }}
          />
          <button className="btn primary" onClick={() => void create()} disabled={!draftName.trim()}>
            Create
          </button>
        </div>

        {collections.length === 0 ? (
          <p className="hint">No collections yet.</p>
        ) : (
          collections.map((collection) => (
            <div key={collection.id} className="folder-row">
              {renaming === collection.id ? (
                <input
                  className="input"
                  style={{ flex: 1 }}
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => void commitRename(collection)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void commitRename(collection);
                    if (event.key === 'Escape') setRenaming(undefined);
                  }}
                />
              ) : (
                <button
                  className="link-cell"
                  onClick={() => onOpen(collection.id)}
                  title="Open this collection"
                >
                  {collection.name}
                </button>
              )}

              <span className="hint" style={{ margin: 0 }}>
                {collection.comicIds.length}
              </span>
              <button
                className="btn"
                onClick={() => {
                  setRenaming(collection.id);
                  setRenameDraft(collection.name);
                }}
              >
                Rename
              </button>
              <button className="btn" onClick={() => void remove(collection)}>
                Delete
              </button>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
