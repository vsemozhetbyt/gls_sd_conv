/******************************************************************************/
'use strict';
/******************************************************************************/
const path = require('path');

const fpath = process.argv[2] || '';
const fext = path.extname(fpath);

if (!fpath || process.argv[3] || !['.gls', '.ifo'].includes(fext)) {
  const scriptName = path.basename(__filename);
  console.error(xs`

    Usage 1: ${scriptName} dictionary.gls

    Usage 2: ${scriptName} dictionary.ifo
  `);
  process.exit(1);
}

console.log('');
/******************************************************************************/
const fs = require('fs');
const rl = require('readline');
const { execSync } = require('child_process');

const getByteLength = Buffer.byteLength;

const changeExtRE = /(?:\.[^.]+)?$/;

const inCoding  = 'utf8';
const outCoding = 'utf8';

const bomRE = /^\uFEFF/;

const INT_BYTES = 4;
const intBf = Buffer.alloc(INT_BYTES);

const HEADWORD_EDGE = 256;

const inDic = Object.create(null);
const outDic = Object.create(null);

const UPDATE_PB_SYNC_PACE = 1000;
/******************************************************************************/
if (fext === '.gls') gls2sd();
else                 sd2gls();
/******************************************************************************/
/******************************************************************************/
/******************************************************************************/
function gls2sd() {
  inDic.rli = rl.createInterface({ input: fs.createReadStream(fpath, inCoding) });

  inDic.directives = Object.create(null);
  inDic.hasDirectives = false;
  inDic.dic = [];
  inDic.syns = [];

  inDic.empties = [];
  inDic.article = [];

  inDic.dirRE = /^#+\s*(.+?)\s*[:?]\s*(.*)/;
  inDic.articleRE = /^[^#]/;

  inDic.lineNumber = 0;

  inDic.isDirectivesZone = true;
  inDic.errors = false;

  readGLS();
}
/******************************************************************************/
function readGLS() {
  console.log('Reading .gls file...\n');
  inDic.pb = pb(fs.statSync(fpath).size);
  inDic.pb.start();

  inDic.rli.on('line', (line) => {
    inDic.pb.stat +=  getByteLength(line, inCoding) + 1;

    if (++inDic.lineNumber === 1) {
      line = line.replace(bomRE, '').trim();

      if (inDic.articleRE.test(line)) {
        abortOnParsingError(
          `Error: no empty line before article at line ${inDic.lineNumber}.`
        );
      }
    } else {
      line = line.trim();
    }

    if (!line) {
      inDic.empties.push(line);

      if (inDic.hasDirectives) {
        inDic.isDirectivesZone = false;
      }

      if (!inDic.isDirectivesZone) {
        addGLSArticle();
      }
    } else if (inDic.articleRE.test(line) || !inDic.isDirectivesZone) {
      if (inDic.article.length === 0) {
        if (inDic.empties.length) {
          inDic.isDirectivesZone = false;
          inDic.empties.length = 0;

          const headwords = line.split(/\s*\|\s*/).filter(elem => elem);

          if (!headwords.length) {
            abortOnParsingError(
              `Error: no headwords in the article at line ${inDic.lineNumber}.`
            );
          }

          if (headwords.some(hw => getByteLength(hw, inCoding) >= HEADWORD_EDGE)) {
            abortOnParsingError(xs`
              Error: headword should be less than ${HEADWORD_EDGE} bytes
              in the article at line ${inDic.lineNumber}.
            `);
          }

          inDic.article.push(headwords);
        } else {
          abortOnParsingError(
            `Error: no empty line before article at line ${inDic.lineNumber}.`
          );
        }
      } else if (inDic.article.length === 1) {
        inDic.article.push(line);
      } else {
        abortOnParsingError(
          `Error: wrong article format at line ${inDic.lineNumber}.`
        );
      }
    } else {
      inDic.empties.length = 0;

      const [, k, v] = line.match(inDic.dirRE) || [];
      if (k) {
        inDic.directives[k] = v;
        inDic.hasDirectives = true;
      }
    }
  }).on('close', () => {
    inDic.pb.end();

    addGLSArticle();

    if (!inDic.errors && inDic.dic.length) {
      writeSDDic();
      if (inDic.syns.length) writeSDSyn();
      writeSDIfo();
    }

    console.log(
      `${inDic.dic.length} articles with ${inDic.syns.length} synonyms saved.\n`
    );

    console.log('Trying to pack the .dict file by dictzip...\n');
    packDICTfile();
  });
}
/******************************************************************************/
function addGLSArticle() {
  if (inDic.article.length === 2) {
    inDic.dic.push(inDic.article.slice());
    inDic.article.length = 0;
  } else if (inDic.article.length) {
    abortOnParsingError(
      `Error: wrong article format before line ${inDic.lineNumber}.`
    );
  }
}
/******************************************************************************/
function writeSDDic() {
  console.log('Sorting the dictionary...\n');
  inDic.dic.forEach((artcl, i) => { artcl.push(i); }); // for stable sorting
  inDic.dic.sort(sortSDDic);

  outDic.idxFile = fs.openSync(fpath.replace(changeExtRE, '.idx'), 'w');
  outDic.dictFile = fs.openSync(fpath.replace(changeExtRE, '.dict'), 'w');

  let   defOffset = 0;

  console.log('Writing .idx and .dict files...\n');
  outDic.pb = pb(inDic.dic.length);

  inDic.dic.forEach((artcl, i) => {
    if (i % UPDATE_PB_SYNC_PACE === 0) outDic.pb.update(i);

    const [[hw1, ...hwSyns], def] = artcl;

    const defLen = getByteLength(def, inCoding);

    fs.writeSync(outDic.idxFile, `${hw1}\0`, null, outCoding);

    intBf.writeUInt32BE(defOffset, 0);
    fs.writeSync(outDic.idxFile, intBf, 0, INT_BYTES);

    intBf.writeUInt32BE(defLen, 0);
    fs.writeSync(outDic.idxFile, intBf, 0, INT_BYTES);

    defOffset += defLen;

    fs.writeSync(outDic.dictFile,
      `${def}`,
    null, outCoding);

    hwSyns.forEach((syn) => {
      inDic.syns.push([syn, i]);
    });
  });

  const idxGzipBuffer = require('zlib').gzipSync(
    fs.readFileSync(fpath.replace(changeExtRE, '.idx'))
  );
  fs.writeFileSync(fpath.replace(changeExtRE, '.idx.gz'), idxGzipBuffer);

  outDic.pb.end();
}
/******************************************************************************/
function writeSDSyn() {
  inDic.syns.sort(sortSDSyns);

  outDic.synsFile = fs.openSync(fpath.replace(changeExtRE, '.syn'), 'w');

  console.log('Writing .syn file...\n');

  inDic.syns.forEach((syn) => {
    fs.writeSync(outDic.synsFile, `${syn[0]}\0`, null, outCoding);

    intBf.writeUInt32BE(syn[1], 0);
    fs.writeSync(outDic.synsFile, intBf, 0, INT_BYTES);
  });
}
/******************************************************************************/
function writeSDIfo() {
  console.log('Writing .ifo file...\n');

  const directivesToFilter = [
    'version',
    'Bookname', 'Glossary title',
    'Wordcount', 'Synwordcount',
    'Idxfilesize', 'Sametypesequence',
    'Glossary section',
  ];

  fs.writeFileSync(fpath.replace(changeExtRE, '.ifo'), xs`
    StarDict's dict ifo file
    version=2.4.2
    bookname=${inDic.directives['Glossary title'] || path.basename(fpath, fext)}
    wordcount=${inDic.dic.length}
    synwordcount=${inDic.syns.length}
    idxfilesize=${fs.fstatSync(outDic.idxFile).size}
    sametypesequence=h
    ${Object.keys(inDic.directives)
      .filter(k => !directivesToFilter.includes(k))
      .map(k => `${k.toLowerCase().replace(/ /g, '_')}=${inDic.directives[k]}`)
      .join('\n')
    }

  `, 'utf8');

  fs.closeSync(outDic.idxFile);
  fs.unlinkSync(fpath.replace(changeExtRE, '.idx'));
}
/******************************************************************************/
function sortSDDic(a, b) {
  const HWa = a[0][0];
  const HWb = b[0][0];

  const asciiLowerCaseHWa = HWa.replace(/[A-Z]/g, m => m.toLowerCase());
  const asciiLowerCaseHWb = HWb.replace(/[A-Z]/g, m => m.toLowerCase());

  if (asciiLowerCaseHWa < asciiLowerCaseHWb) return -1;

  if (asciiLowerCaseHWa > asciiLowerCaseHWb) return 1;

  if (HWa < HWb) return -1;

  if (HWa > HWb) return 1;

  return a[2] - b[2]; // for stable sorting
}
/******************************************************************************/
function sortSDSyns(a, b) {
  const SYNa = a[0];
  const SYNb = b[0];

  const asciiLowerCaseSYNa = SYNa.replace(/[A-Z]/g, m => m.toLowerCase());
  const asciiLowerCaseSYNb = SYNb.replace(/[A-Z]/g, m => m.toLowerCase());

  if (asciiLowerCaseSYNa < asciiLowerCaseSYNb) return -1;

  if (asciiLowerCaseSYNa > asciiLowerCaseSYNb) return 1;

  if (SYNa < SYNb) return -1;

  if (SYNa > SYNb) return 1;

  return 0;
}
/******************************************************************************/
function packDICTfile() {
  try {
    execSync(`dictzip ${fpath.replace(changeExtRE, '.dict')}`);
    console.log('.dict file is packed successfully.');
  } catch (error) {
    console.error(`dictzip error: ${error}`);
  }
}
/******************************************************************************/
/******************************************************************************/
/******************************************************************************/
function sd2gls() {
  inDic.inDir = path.dirname(fpath);
  inDic.basename = path.basename(fpath, '.ifo');
  inDic.needFiles = ['.ifo', '.idx', '.idx.gz', '.dict', '.dict.dz', '.syn']
                    .map(ext => `${inDic.basename}${ext}`);
  inDic.foundfiles = fs.readdirSync(inDic.inDir)
                  .filter(f =>  inDic.needFiles.includes(f));

  if (!inDic.foundfiles.includes(`${inDic.basename}.ifo`)) {
    console.error('.ifo file not found.');
    process.exit(1);
  }
  if (!inDic.foundfiles.includes(`${inDic.basename}.idx`) &&
      !inDic.foundfiles.includes(`${inDic.basename}.idx.gz`)) {
    console.error('.idx (or .idx.gz) file not found.');
    process.exit(1);
  }
  if (!inDic.foundfiles.includes(`${inDic.basename}.dict`) &&
      !inDic.foundfiles.includes(`${inDic.basename}.dict.dz`)) {
    console.error('.dict (or .dict.dz) file not found.');
    process.exit(1);
  }

  inDic.foundfiles = inDic.foundfiles.map(f => path.join(inDic.inDir, f));

  inDic.directives = Object.create(null);
  inDic.dic = [];
  inDic.syns = [];

  inDic.dirRE = /^\s*(\w+)\s*=\s*(.*)/;

  inDic.errors = false;

  readSDIfo();
  if (inDic.foundfiles.some(f => f.endsWith('.syn'))) readSDSyn();
  readSDDic();

  if (!inDic.errors && inDic.dic.length) {
    writeGLS();
  }

  console.log(
    `${inDic.dic.length} articles with ${inDic.syns.length} synonyms saved.`
  );
}
/******************************************************************************/
function readSDIfo() {
  console.log('Reading .ifo file...\n');

  fs.readFileSync(inDic.foundfiles.find(f => f.endsWith('.ifo')), inCoding)
    .replace(/^\uFEFF/, '')
    .split(/[\n\r]+/)
    .forEach((line) => {
      const [, k, v] = line.match(inDic.dirRE) || [];
      if (k) inDic.directives[k] = v;
    });

  if (inDic.directives.sametypesequence !== 'h') {
    console.error(
      "Only StarDict's dictionaries with 'sametypesequence=h' are supported."
    );
    process.exit(1);
  }
  if (inDic.directives.idxoffsetbits === '64') {
    console.error(
      "Only StarDict's dictionaries with 'idxoffsetbits=32' are supported."
    );
    process.exit(1);
  }
}
/******************************************************************************/
function readSDSyn() {
  console.log('Reading .syn file...\n');

  inDic.synBf = fs.readFileSync(inDic.foundfiles.find(f => f.endsWith('.syn')));

  let synOffset = 0;
  while (synOffset < inDic.synBf.length) {
    const synBf = [];
    let   byte;
    while ((byte = inDic.synBf[synOffset++])) synBf.push(byte);

    const i = inDic.synBf.readUInt32BE(synOffset);
    synOffset += INT_BYTES;

    inDic.syns.push([
      Buffer.from(synBf).toString(inCoding),
      i,
    ]);
  }

  delete inDic.synBf;
}
/******************************************************************************/
function readSDDic() {
  console.log('Reading .idx and .dict files...\n');

  if (inDic.foundfiles.some(f => f.endsWith('.idx'))) {
    inDic.idxBf = fs.readFileSync(inDic.foundfiles.find(f => f.endsWith('.idx')));
  } else {
    inDic.zlib = require('zlib');

    inDic.idxBf = inDic.zlib.unzipSync(
      fs.readFileSync(inDic.foundfiles.find(f => f.endsWith('.idx.gz')))
    );
  }

  if (inDic.foundfiles.some(f => f.endsWith('.dict'))) {
    inDic.dictBf = fs.readFileSync(inDic.foundfiles.find(f => f.endsWith('.dict')));
  } else {
    if (!inDic.zlib) inDic.zlib = require('zlib');

    inDic.dictBf = inDic.zlib.unzipSync(
      fs.readFileSync(inDic.foundfiles.find(f => f.endsWith('.dict.dz')))
    );
  }

  console.log('Processing .idx and .dict files...\n');
  inDic.pb = pb(inDic.directives.wordcount);

  let idxOffset = 0;
  while (idxOffset < inDic.idxBf.length) {
    const added = inDic.dic.length;
    if (added % UPDATE_PB_SYNC_PACE === 0) inDic.pb.update(added);

    const hwBf = [];
    let   byte;
    while ((byte = inDic.idxBf[idxOffset++])) hwBf.push(byte);

    const dataOffset = inDic.idxBf.readUInt32BE(idxOffset);
    idxOffset += INT_BYTES;
    const dataSize = inDic.idxBf.readUInt32BE(idxOffset);
    idxOffset += INT_BYTES;

    inDic.dic.push([
      [Buffer.from(hwBf).toString(inCoding)],
      inDic.dictBf.toString(inCoding, dataOffset, dataOffset + dataSize),
    ]);
  }

  inDic.pb.end();
  delete inDic.idxBf;
  delete inDic.dictBf;

  if (inDic.syns.length) {
    console.log('Adding synonyms...\n');

    inDic.syns.forEach((rec) => {
      const [syn, i] = rec;
      inDic.dic[i][0].push(syn);
    });
  }
}
/******************************************************************************/
function writeGLS() {
  console.log('Writing .gls file...\n');

  outDic.glsFile = fs.openSync(fpath.replace(changeExtRE, '.gls'), 'w');
  fs.writeSync(outDic.glsFile, '\uFEFF', null, outCoding);

  const directivesToFilter = [
    'version',
    'wordcount', 'synwordcount',
    'idxfilesize', 'idxoffsetbits',
    'sametypesequence',
  ];

  fs.writeSync(outDic.glsFile,
    Object.keys(inDic.directives)
      .filter(k => !directivesToFilter.includes(k))
      .map(k => `### ${
        k.replace(/^bookname$/, 'Glossary title')
         .replace(/^\w/, char => char.toUpperCase())
         .replace(/_/g, ' ')
      }:${inDic.directives[k]}`)
      .concat('### Glossary section:')
      .join('\n')
      .concat('\n\n'),
  null, outCoding);

  outDic.pb = pb(inDic.dic.length);

  inDic.dic.forEach((artcl, i) => {
    if (i % UPDATE_PB_SYNC_PACE === 0) outDic.pb.update(i);

    fs.writeSync(outDic.glsFile,
      `${artcl[0].join('|')}\n${artcl[1]}\n\n`,
    null, outCoding);
  });

  outDic.pb.end();
}
/******************************************************************************/
/******************************************************************************/
/******************************************************************************/
function abortOnParsingError(msg) {
  inDic.errors = true;
  inDic.pb.clear();
  console.error(msg);
  process.exit(1);
}
/******************************************************************************/
// remove auxiliary code spaces in template strings

function xs(strings, ...expressions) {
  const firstIndentRE = /\n +/;
  const indentSize = firstIndentRE.exec(
    strings.find(str => firstIndentRE.test(str))
  )[0].length - 1;

  const xLfRE = /^\n|\n$/g;
  const xSpRE = new RegExp(`\n {0,${indentSize}}`, 'g');

  if (!expressions.length) return strings[0].replace(xSpRE, '\n').replace(xLfRE, '');

  return strings.reduce((acc, str, i) =>
    (i === 1 ? acc.replace(xSpRE, '\n') : acc) +
    expressions[i - 1] +
    str.replace(xSpRE, '\n')
  ).replace(xLfRE, '');
}
/******************************************************************************/
// progress bar

function pb(edge = 0) {
  const DEFAULT_FREQ = 500;
  const HUNDRED_PERCENT = 100;
  const PB_LENGTH = 50;
  const PB_SCALE = HUNDRED_PERCENT / PB_LENGTH;

  function clearLine() {
    rl.cursorTo(process.stdout, 0);
    rl.clearLine(process.stdout, 0);
  }

  return {
    edge,
    stat: 0,

    start(freq = DEFAULT_FREQ) {
      this.updater = setInterval(() => { this.update(); }, freq);
    },

    update(stat = this.stat) {
      let statPercent = Math.ceil(stat / this.edge * HUNDRED_PERCENT);
      if (statPercent > HUNDRED_PERCENT) statPercent = HUNDRED_PERCENT;

      const barsNumber = Math.floor(statPercent / PB_SCALE);
      const padsNumber = PB_LENGTH - barsNumber;

      clearLine();
      process.stdout.write(
        `${'█'.repeat(barsNumber)}${' '.repeat(padsNumber)} ${statPercent}%`
      );
    },

    end() {
      clearInterval(this.updater);
      this.stat = this.edge;
      this.update();
      console.log('\n');
    },

    clear() {
      clearInterval(this.updater);
      clearLine();
    },
  };
}
/******************************************************************************/
/******************************************************************************/
/******************************************************************************/
