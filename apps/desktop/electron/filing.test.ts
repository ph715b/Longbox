import { strict as assert } from 'node:assert';
import test from 'node:test';
import { listParents } from './filing.ts';

/**
 * Where a new series folder gets created.
 *
 * A real bug: with each series folder watched separately, a new folder was
 * created inside whichever root sorted first, so "Absolute Wonder Woman" ended
 * up nested inside "Absolute Batman".
 */

const defaultParent = (roots: string[]) => listParents(roots)[0]?.path;

test('series folders watched individually put a new folder beside them', () => {
  const roots = [
    'D:\\EBooks\\Comics\\Absolute Green Lantern',
    'D:\\EBooks\\Comics\\Absolute Batman',
  ];
  assert.equal(defaultParent(roots), 'D:\\EBooks\\Comics');
  // Every root stays available for the case where nesting is actually wanted.
  assert.equal(listParents(roots).length, 3);
});

test('a single watched folder is the library folder, not its parent', () => {
  // Offering D:\EBooks would create series folders outside the watched root,
  // where nothing would ever scan them.
  assert.equal(defaultParent(['D:\\EBooks\\Comics']), 'D:\\EBooks\\Comics');
  assert.equal(listParents(['D:\\EBooks\\Comics']).length, 1);
});

test('libraries on different drives share no parent', () => {
  const roots = ['D:\\EBooks\\Comics', 'E:\\Media\\Comics'];
  const parents = listParents(roots);
  assert.equal(parents.length, 2, 'no invented common parent across drives');
  assert.deepEqual(parents.map((parent) => parent.path), roots);
});

test('a drive root is never offered as the library folder', () => {
  // These share only "D:", which is not somewhere to file comics.
  const parents = listParents(['D:\\Comics', 'D:\\Manga']);
  assert.ok(
    !parents.some((parent) => /^[A-Za-z]:\\?$/.test(parent.path)),
    'must not offer a bare drive',
  );
});

test('with nothing watched there is nowhere to put a new folder', () => {
  assert.deepEqual(listParents([]), []);
});
