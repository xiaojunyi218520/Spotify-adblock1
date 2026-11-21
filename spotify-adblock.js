// Spotify 去广告(重写版) — 2026-10-04
// 拦截 spclient 的 bootstrap / customize 接口 protobuf 响应,把账号属性改写成 premium 形态,
// 去除音频广告与随机播放限制。
// 与旧版(app2smile 2026-02-25)的区别:
//  1. 不再捆绑 70KB 的 protobuf 库和写死的 schema,改用自研最小 wire 解析器;
//  2. 未知字段原样保留(旧版 decode 再 encode 会丢弃 App 新版本新增的字段,
//     这很可能就是之前导致 App 显示离线的原因);
//  3. 按"结构特征"搜索属性表,而不是写死深层路径,App 改版后更耐操;
//  4. 任何异常直接放行原始响应,绝不破坏 App 正常请求。
console.log('spotify-adblock-2026.10.04');

var TARGETS = {
  'ads': ['b', false],
  'type': ['s', 'premium'],
  'name': ['s', 'Spotify Premium'],
  'catalogue': ['s', 'premium'],
  'player-license': ['s', 'premium'],
  'on-demand': ['b', true],
  'shuffle': ['b', false],
  'pick-and-shuffle': ['b', false],
  'shuffle-algorithm': ['s', 'RANDOM'],
  'unrestricted': ['b', true],
  'high-bitrate': ['b', true],
  'offline': ['b', true],
  'offline-backup': ['s', 'UNRESTRICTED'],
  'lyrics-offline': ['b', true],
  'streaming-rules': ['s', ''],
  'libspotify': ['b', true],
  'mobile': ['b', true],
  'nft-disabled': ['s', '1'],
  'loudness-levels': ['s', '1:-5.0,0.0,3.0:-2.0'],
  'audio-quality': ['s', '1'],
  'smart-shuffle': ['s', 'AVAILABLE'],
  'is-euterpe': ['b', true],
  'is-thalia': ['b', true],
  'is-pigeon': ['b', true],
  'has-audiobooks-subscription': ['b', true],
  'payments-initial-campaign': ['s', 'prepaid'],
  'social-session-free-tier': ['b', false],
  'social-session': ['b', true],
  'jam-social-session': ['s', 'EXPANDED'],
  'can_use_superbird': ['b', true],
  'your-library-tags': ['b', true],
  'mixing-tools': ['s', 'EDIT'],
  'financial-product': ['s', 'pr:premium,tc:0'],
  'com.spotify.madprops.use.ucs.product.state': ['b', true],
  'com.spotify.madprops.delivered.by.ucs': ['b', true]
};
(function () {
  var d = new Date();
  d.setMonth(d.getMonth() + 1);
  var s = d.toISOString().split('.')[0] + 'Z';
  TARGETS['subscription-enddate'] = ['s', s];
  TARGETS['product-expiry'] = ['s', s];
})();

/* ---------- 最小 protobuf wire 编解码 ---------- */
function readVarint(u8, pos) {
  var val = 0, mul = 1, b;
  do {
    if (pos >= u8.length) throw 'varint_oob';
    b = u8[pos++];
    val += (b & 0x7F) * mul;
    mul *= 128;
  } while (b & 0x80);
  return { val: val, pos: pos };
}
function pushVarint(out, val) {
  val = Math.floor(val);
  while (val > 0x7F) { out.push((val % 128) | 0x80); val = Math.floor(val / 128); }
  out.push(val);
}
function parseMsg(u8, start, end) {
  var fields = [], pos = start;
  while (pos < end) {
    var k = readVarint(u8, pos); pos = k.pos;
    var num = Math.floor(k.val / 8), wire = k.val % 8;
    var f = { num: num, wire: wire };
    if (wire === 0) {
      var v = readVarint(u8, pos);
      f.data = u8.slice(pos, v.pos); pos = v.pos;
    } else if (wire === 1) {
      if (pos + 8 > end) throw 'fix64_oob';
      f.data = u8.slice(pos, pos + 8); pos += 8;
    } else if (wire === 2) {
      var l = readVarint(u8, pos); pos = l.pos;
      if (l.val < 0 || pos + l.val > end) throw 'len_oob';
      f.data = u8.slice(pos, pos + l.val); pos += l.val;
    } else if (wire === 5) {
      if (pos + 4 > end) throw 'fix32_oob';
      f.data = u8.slice(pos, pos + 4); pos += 4;
    } else { throw 'wire_' + wire; }
    fields.push(f);
    if (fields.length > 20000) throw 'too_many_fields';
  }
  if (pos !== end) throw 'trailing';
  return fields;
}
function tryParse(u8) {
  try { return parseMsg(u8, 0, u8.length); } catch (e) { return null; }
}
/* 序列化:只有带 sub 的字段才重新序列化,其余原字节照发 */
function serTree(fields) {
  var out = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    pushVarint(out, f.num * 8 + f.wire);
    var data = f.sub ? serTree(f.sub) : f.data;
    if (f.wire === 2) pushVarint(out, data.length);
    for (var j = 0; j < data.length; j++) out.push(data[j]);
  }
  return new Uint8Array(out);
}
function strBytes(s) {
  var a = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xFF;
  return a;
}
function bytesStr(u8) {
  var s = '';
  for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}

/* ---------- 属性表定位 ---------- */
// map 在 wire 上的形态: {1: key(string), 2: value(message)} 的一次或多次出现
function splitEntries(data) {
  var fs = tryParse(data);
  if (!fs || !fs.length) return null;
  var entries = [], cur = null;
  for (var i = 0; i < fs.length; i++) {
    var f = fs[i];
    if (f.num === 1 && f.wire === 2 && cur === null) {
      cur = { key: bytesStr(f.data), valBytes: null, efields: [f] };
    } else if (f.num === 2 && f.wire === 2 && cur !== null && cur.valBytes === null) {
      cur.valBytes = f.data;
      cur.efields.push(f);
      entries.push(cur);
      cur = null;
    } else {
      return null;
    }
  }
  if (cur !== null || !entries.length) return null;
  return entries;
}
// AccountAttribute 结构特征: oneof { boolValue(2,varint) | longValue(3,varint) | stringValue(4,bytes) }
function isAttrMsg(data) {
  var fs = tryParse(data);
  if (!fs || !fs.length) return false;
  for (var i = 0; i < fs.length; i++) {
    var f = fs[i], ok = (f.num === 2 && f.wire === 0) ||
                        (f.num === 3 && f.wire === 0) ||
                        (f.num === 4 && f.wire === 2);
    if (!ok) return false;
  }
  return true;
}
function setAttrVal(valBytes, spec) {
  var fs = parseMsg(valBytes, 0, valBytes.length);
  var out = [];
  for (var i = 0; i < fs.length; i++) {
    var f = fs[i];
    if (f.num < 2 || f.num > 4) out.push(f); // oneof 之外的字段原样保留
  }
  if (spec[0] === 'b') out.push({ num: 2, wire: 0, data: new Uint8Array([spec[1] ? 1 : 0]) });
  else out.push({ num: 4, wire: 2, data: strBytes(spec[1]) });
  return serTree(out);
}

function walk(fields, maps, found, depth) {
  if (depth > 12) return false;
  var dirty = false;
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.wire !== 2 || !f.data.length) continue;
    var entries = splitEntries(f.data);
    var isAttrMap = false;
    if (entries) {
      for (var e = 0; e < entries.length; e++) {
        if (isAttrMsg(entries[e].valBytes)) { isAttrMap = true; break; }
      }
    }
    if (isAttrMap) {
      maps.push({ arr: fields, num: f.num });
      var ef = [], fieldDirty = false;
      for (var a = 0; a < entries.length; a++) {
        var en = entries[a];
        if (isAttrMsg(en.valBytes) && Object.prototype.hasOwnProperty.call(TARGETS, en.key)) {
          var nv = setAttrVal(en.valBytes, TARGETS[en.key]);
          var nef = en.efields.slice();
          for (var j = 0; j < nef.length; j++) {
            if (nef[j].num === 2) nef[j] = { num: 2, wire: 2, data: nv };
          }
          ef = ef.concat(nef);
          found[en.key] = true;
          fieldDirty = true;
        } else {
          ef = ef.concat(en.efields);
        }
      }
      if (fieldDirty) { f.sub = ef; dirty = true; }
      continue;
    }
    var sub = tryParse(f.data);
    if (sub && walk(sub, maps, found, depth + 1)) { f.sub = sub; dirty = true; }
  }
  return dirty;
}

function patchAttrs(u8) {
  var root = parseMsg(u8, 0, u8.length);
  var maps = [], found = {};
  var dirty = walk(root, maps, found, 0);
  if (!maps.length) return null; // 没找到属性表,原样放行
  // 缺失的 key 直接插入新条目
  var host = maps[0];
  for (var k in TARGETS) {
    if (!Object.prototype.hasOwnProperty.call(TARGETS, k) || found[k]) continue;
    var spec = TARGETS[k];
    var valFields = spec[0] === 'b'
      ? [{ num: 2, wire: 0, data: new Uint8Array([spec[1] ? 1 : 0]) }]
      : [{ num: 4, wire: 2, data: strBytes(spec[1]) }];
    host.arr.push({
      num: host.num, wire: 2,
      sub: [{ num: 1, wire: 2, data: strBytes(k) }, { num: 2, wire: 2, sub: valFields }]
    });
    dirty = true;
  }
  if (!dirty) return u8; // 无需改动,直接返回原字节
  return serTree(root);
}

function toU8(body) {
  if (body instanceof Uint8Array) return body;
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') {
    var a = new Uint8Array(body.length);
    for (var i = 0; i < body.length; i++) a[i] = body.charCodeAt(i) & 0xFF;
    return a;
  }
  throw 'unknown_body_type';
}

function main() {
  try {
    var status = $response.status ? $response.status : $response.statusCode;
    if (status !== 200) { console.log('status ' + status + ', pass'); return $done({}); }
    var url = $request.url || '';
    var method = ($request.method || '').toUpperCase();
    if (method !== 'POST') return $done({});
    if (url.indexOf('bootstrap/v1/bootstrap') < 0 &&
        url.indexOf('user-customization-service/v1/customize') < 0) return $done({});
    if (!$response.body) return $done({});
    var u8 = toU8($response.body);
    var out = patchAttrs(u8);
    if (!out) { console.log('no attr map, pass'); return $done({}); }
    if (out === u8) { console.log('nothing to change, pass'); return $done({}); }
    console.log('patched ' + u8.length + ' -> ' + out.length + ' bytes');
    return $done({ body: out });
  } catch (e) {
    console.log('error, pass through: ' + e);
    return $done({});
  }
}
main();
