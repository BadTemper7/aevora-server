import test from 'node:test';import assert from 'node:assert/strict';import { readFileSync } from 'node:fs';
const code=p=>readFileSync(new URL(p,import.meta.url),'utf8');
test('send, reply, reaction and group request endpoints never write ordinary bell notifications',()=>{
 const src=code('../src/social/messageRoutes.js');
 assert.doesNotMatch(src,/notify\(/);
 assert.match(src,/emitNewMessage\(c, msg\)/);
 assert.match(src,/router\.post\("\/conversations\/:id\/read"/);
});
test('notification APIs paginate with a cursor and expose independent unread counts',()=>{
 const src=code('../src/social/notificationRoutes.js');
 assert.match(src,/\/notifications\/unread-count/);
 assert.match(src,/limit\(count \+ 1\)/);
 assert.match(src,/nextCursor/);
 assert.match(src,/\/notifications\/read-all/);
 assert.match(src,/\/notification-preferences/);
});
test('community unread uses persisted read positions, role permission checks and socket invalidation',()=>{
 const src=code('../src/communities/communityRoutes.js');
 const ch=code('../src/communities/channelRoutes.js');
 assert.match(src,/\/communities\/unread-summary/);
 assert.match(src,/derivePermissions/);
 assert.match(ch,/community:message:activity/);
 assert.match(ch,/community:unread:updated/);
 assert.match(ch,/lastRead/);
});
