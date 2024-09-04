/* global importScripts, zip */

//importScripts('./lib/zip.js');
//importScripts('./lib/ArrayBufferReader.js');
//importScripts('./lib/deflate.js');
//importScripts('./lib/inflate.js');



//var ZIP_URL = './big3.tar.gz';
//var ZIP_URL = './ct_report.tar.gz';
//var ZIP_URL = 'https://circleci-mim-results.s3.eu-central-1.amazonaws.com/PR/4367/236734/elasticsearch_and_cassandra_mnesia.27.0.1-amd64/big.tar.gz';
var ZIP_URL = 'http://localhost:8000/big.tar.gz';


const swListener = new BroadcastChannel('swListener');
swListener.postMessage("Importing scripts");

//importScripts('./lib/web-streams-polyfill.min.js');
//importScripts('./lib/zip-no-worker.min.js');
//importScripts('./lib/zip-full.min.js');

const SCOPE = "https://arcusfelis.github.io/html-zip-reader";

importScripts(SCOPE + '/lib/tar-web.js');
importScripts(SCOPE + '/lib/readable-web-to-node-stream.js');
importScripts(SCOPE + '/lib/blob-stream.js');

//zip.configure({useWebWorkers: false, useCompressionStream: true});
swListener.postMessage("Scripts imported");

/*
let call = 0;
BlobStream.prototype._write_orig = BlobStream.prototype._write;
BlobStream.prototype._write = function(chunk, encoding, callback) {
//if (!call)
    console.log("chunk1 " + chunk.length);
  call++;
  return this._write_orig(chunk, encoding, callback);
}
*/

function mergeArrays(myArrays) {
if (myArrays.length == 0) return "";
if (myArrays.length == 1) return myArrays[0];
return myArrays;

/*
// Get the total length of all arrays.
let length = 0;
myArrays.forEach(item => {
  length += item.length;
});

// Create a new array with total length and merge all source arrays.
let mergedArray = new Uint8Array(length);
let offset = 0;
myArrays.forEach(item => {
  mergedArray.set(item, offset);
  offset += item.length;
});
return mergedArray;
*/
}

// During installation, extend the event to recover the package
// for this recipe and install into an offline cache.
self.oninstall = function(event) {
  console.log("worker.path=" + self.location.href);
/*
  caches.keys().then(function(names) {
      for (let name of names)
          caches.delete(name);
  });
*/
  swListener.postMessage("Downloading zip");
  const skip = self.skipWaiting.bind(self);
  const bodyPromise = fetch(ZIP_URL)
      .then(function(response) {
         return response.body;
      })
      .then(function(rs) {
         console.log("Fetch Response Stream");
         return rs;
      });
  const cachePromise = openCache();
  event.waitUntil(
      Promise.all([bodyPromise, cachePromise])
      .then(function(values) {
      const [body, cache] = values;
      var startTime = performance.now();
        swListener.postMessage("Downloaded zip");
        const ds = new DecompressionStream("gzip");
        const decompressedStream = body.pipeThrough(ds);
        const extract = tar.extract();
        const files = {};
        let entriesCount = 0;
        
        extract.on('entry', function (header, stream, next) {
          entriesCount++;
          if (header.type == "directory") {
            next();
            stream.resume();
            return;
          }
          files[header.name] = extract._offset;
          next(); // ready for next entry
          stream.resume(); // just auto drain the stream
        });
        extract.on('finish', function () {
          var endTime = performance.now();
          swListener.postMessage("Installed " + (endTime - startTime) + " milliseconds");
          // all entries read
          console.log("all entries read " + entriesCount);
          skip();
        });
        
        const [decompressedStream1, decompressedStream2] = decompressedStream.tee();
        const nodeStream = new ReadableWebToNodeStream(decompressedStream1);
        nodeStream.pipe(extract);

        fetchStream(decompressedStream2);
      })
  );
};

function fetchStream(stream) {
  const reader = stream.getReader();
  let bytesReceived = 0;
  let absOffset = 0;
  let partOffset = 0;

  const PART_SIZE = 1000000;
  let PART_NUM = 0;
  const chunks = [];

  // read() returns a promise that resolves
  // when a value has been received
  reader.read().then(function processChunk({ done, value }) {
    // Result objects contain two properties:
    // done  - true if the stream has already given you all its data.
    // value - some data. Always undefined when done is true.
    if (done) {
      console.log("Stream complete");
      return;
    }

    // value for fetch streams is a Uint8Array
    bytesReceived += value.length;
    absOffset += value.length;
//  console.log("get chunk " + value.length);

    chunks.push(value);

    if (bytesReceived > PART_SIZE) {
      // split logic
      console.log("Part received partSize=" + bytesReceived + " partOffset=" + partOffset);
      chunks.length = 0;
      bytesReceived = 0;
      partOffset = absOffset;
    }

    // Read some more, and call this function again
    return reader.read().then(processChunk);
  });
}

// Control the clients as soon as possible.
self.onactivate = function(event) {
  event.waitUntil(self.clients.claim());
};

// Answer by querying the cache. If fail, go to the network.
self.onfetch = function(event) {
  console.log("onfetch " + event.request.url);
  swListener.postMessage("onfetch " + event.request.url);
  event.respondWith(openCache().then(function(cache) {
    return cache.match(event.request).then(function(response) {
//    return response || fetch(event.request);
      if (response) return response;
      
      try {
        return fetch(event.request);
      } catch (e) {
        console.log("error in onfetch " + e);
        event.respondWith(new Response(""));
      }
    });
  }));
};

/*
// This wrapper promisifies the zip.js API for reading a zip.
function getZipReader(blob) {
    const reader = new zip.ZipReader(new zip.BlobReader(blob));
    return cacheContents(reader);
}

// Use the reader to read each of the files inside the zip
// and put them into the offline cache.
function cacheContents(reader) {
  return new Promise(function(fulfill, reject) {
    reader.getEntries().then(function(entries) {
      console.log('Installing', entries.length, 'files from zip');
      var startTime = performance.now();

      swListener.postMessage('Installing ' + entries.length + ' files from zip');
      Promise.all(entries.map(cacheEntry)).then(function() {
        var endTime = performance.now();
        swListener.postMessage("Installed " + (endTime - startTime) + " milliseconds");
        fulfill();
      }, reject);
    });
  });
}

// Cache one entry, skipping directories.
function cacheEntry(entry) {
  if (entry.directory) { return Promise.resolve(); }
  self.lastEntry = entry;
    // The writer specifies the format for the data to be read as.
    // This case, we want a generic blob as blob is one of the supported
    // formats for the `Response` constructor.
    return entry.getData(new zip.BlobWriter()).then(function(data) {
      return cacheBlob(entry.filename, data);
  });
}
*/

function cacheBlob(cache, filename, blob) {
//    return openCache().then(function(cache) {
        var location = getLocation(filename);
        var response = new Response(blob, { headers: {
          // As the zip says nothing about the nature of the file, we extract
          // this information from the file name.
          'Content-Type': getContentType(filename)
        } });

//      console.log('-> Caching', location, '(size:', blob.length, 'bytes)');
//      console.log('-> Caching', location);

        // If the entry is the index, cache its contents for root as well.
        if (filename === 'index.html') {
          // Response are one-use objects, as `.put()` consumes the data in the body
          // we need to clone the response in order to use it twice.
          cache.put(getLocation(), response.clone());
        }

        cache.put(location, response);
//    });
}

// Return the location for each entry.
function getLocation(filename) {
  return location.href.replace(/worker\.js$/, "big/" + (filename || ''));
}

var contentTypesByExtension = {
  'css': 'text/css',
  'js': 'application/javascript',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'html': 'text/html',
  'htm': 'text/html'
};

// Return the content type of a file based on the name extension
function getContentType(filename) {
  var tokens = filename.split('.');
  var extension = tokens[tokens.length - 1];
  return contentTypesByExtension[extension] || 'text/plain';
}

// Opening a cache is an expensive operation. By caching the promise
// returned by `cache.open()` we only open the cache once.
var cachePromise;
function openCache() {
  if (!cachePromise) { cachePromise = caches.open('cache-from-zip'); }
  return cachePromise;
}
