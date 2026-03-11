/**
 * Test Data Generator — DevTools utility for stress-testing large libraries.
 *
 * Usage (from DevTools console in dev mode):
 *   generateTestLibrary(11000)     // 11,000 synthetic local tracks
 *   generateTestDevice(5000)       // 5,000 synthetic device tracks
 *   clearTestData()                // Reset to empty state
 */

(() => {
    // ── Seed data ──────────────────────────────────────────────────────

    const ARTISTS = [
        'Arctic Monkeys', 'Radiohead', 'Tame Impala', 'The Strokes', 'Gorillaz',
        'Daft Punk', 'LCD Soundsystem', 'Boards of Canada', 'Aphex Twin', 'Massive Attack',
        'Portishead', 'Bjork', 'The National', 'Bon Iver', 'Fleet Foxes',
        'Sufjan Stevens', 'Arcade Fire', 'Modest Mouse', 'Built to Spill', 'Pavement',
        'My Bloody Valentine', 'Slowdive', 'Cocteau Twins', 'Beach House', 'Grizzly Bear',
        'Deerhunter', 'Animal Collective', 'Of Montreal', 'Neutral Milk Hotel', 'Elliott Smith',
        'Nick Drake', 'Jeff Buckley', 'Fiona Apple', 'PJ Harvey', 'St. Vincent',
        'Mitski', 'Japanese Breakfast', 'Big Thief', 'Alex G', 'Snail Mail',
        'Mac DeMarco', 'King Gizzard', 'Khruangbin', 'Thundercat', 'Flying Lotus',
        'J Dilla', 'MF DOOM', 'Madvillain', 'Run the Jewels', 'Death Grips',
    ];

    const ALBUM_WORDS = [
        'Moon', 'Sun', 'Night', 'Morning', 'Electric', 'Velvet', 'Golden', 'Silver',
        'Dark', 'Light', 'Deep', 'High', 'Blue', 'Red', 'Black', 'White',
        'Lost', 'Found', 'Broken', 'Whole', 'Silent', 'Loud', 'Soft', 'Hard',
        'Dream', 'Wake', 'Sleep', 'Rise', 'Fall', 'Float', 'Drift', 'Crash',
        'Ocean', 'Mountain', 'River', 'Forest', 'Desert', 'City', 'Garden', 'Storm',
        'Ghost', 'Shadow', 'Mirror', 'Echo', 'Pulse', 'Wave', 'Flame', 'Frost',
    ];

    const TRACK_WORDS = [
        'Walking', 'Running', 'Falling', 'Flying', 'Dancing', 'Singing', 'Breathing', 'Waiting',
        'Fading', 'Burning', 'Shining', 'Glowing', 'Turning', 'Spinning', 'Drifting', 'Floating',
        'Into', 'Through', 'Beyond', 'Under', 'Over', 'Between', 'Around', 'Within',
        'the', 'a', 'my', 'your', 'our', 'their', 'this', 'that',
        'Light', 'Dark', 'Rain', 'Snow', 'Wind', 'Fire', 'Water', 'Earth',
        'Heart', 'Mind', 'Soul', 'Eyes', 'Hands', 'Voice', 'Name', 'Home',
        'Again', 'Forever', 'Never', 'Always', 'Sometimes', 'Tonight', 'Tomorrow', 'Yesterday',
    ];

    const GENRES = [
        'Alternative', 'Indie Rock', 'Electronic', 'Hip Hop', 'Jazz', 'Folk',
        'Post-Rock', 'Shoegaze', 'Dream Pop', 'Trip Hop', 'Ambient', 'Experimental',
        'Punk', 'Post-Punk', 'New Wave', 'Synth Pop', 'R&B', 'Soul',
    ];

    const EXTENSIONS = ['.mp3', '.m4a', '.flac', '.wma'];
    const FORMAT_CODES = { '.mp3': 0x3009, '.m4a': 0x3008, '.flac': 0x3001, '.wma': 0x3001 };

    // ── Helpers ────────────────────────────────────────────────────────

    function pick(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    function pickN(arr, n) {
        const result = [];
        for (let i = 0; i < n; i++) result.push(pick(arr));
        return result;
    }

    function generateAlbumName() {
        const style = Math.random();
        if (style < 0.3) return pick(ALBUM_WORDS);
        if (style < 0.6) return pick(ALBUM_WORDS) + ' ' + pick(ALBUM_WORDS);
        return 'The ' + pick(ALBUM_WORDS) + ' ' + pick(ALBUM_WORDS);
    }

    function generateTrackTitle() {
        const words = pickN(TRACK_WORDS, 2 + Math.floor(Math.random() * 3));
        // Capitalize first word
        words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
        return words.join(' ');
    }

    /**
     * Pre-generate a pool of artists with albums and tracks.
     * Returns { artists, albums, tracks } where tracks is an array of track objects.
     */
    function generateTrackPool(count) {
        const tracks = [];
        const albumArtMap = {};

        // Decide how many albums we need (~10 tracks per album average)
        const albumCount = Math.max(50, Math.ceil(count / 10));
        const albums = [];

        for (let a = 0; a < albumCount; a++) {
            const artist = pick(ARTISTS);
            const albumName = generateAlbumName();
            const genre = pick(GENRES);
            const year = 1990 + Math.floor(Math.random() * 36);
            const trackCount = 6 + Math.floor(Math.random() * 10); // 6-15 tracks per album
            const ext = pick(EXTENSIONS);

            // Generate a deterministic "art" placeholder (1x1 colored pixel as tiny base64)
            const artKey = artist.toLowerCase() + '|' + albumName.toLowerCase();
            // Use a distinct color per album for visual debugging
            const r = (a * 37) % 256, g = (a * 71) % 256, b = (a * 113) % 256;
            albumArtMap[artKey] = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect fill="rgb(${r},${g},${b})" width="1" height="1"/></svg>`;

            albums.push({ artist, albumName, genre, year, trackCount, ext, artKey });
        }

        // Fill tracks from albums until we hit the target count
        let albumIdx = 0;
        while (tracks.length < count) {
            const album = albums[albumIdx % albums.length];

            for (let t = 1; t <= album.trackCount && tracks.length < count; t++) {
                const title = generateTrackTitle();
                const filename = `${String(t).padStart(2, '0')} ${title}${album.ext}`;
                const duration = 120 + Math.floor(Math.random() * 300); // 2-7 minutes

                tracks.push({
                    title,
                    artist: album.artist,
                    album: album.albumName,
                    albumArtist: album.artist,
                    genre: album.genre,
                    year: album.year,
                    trackNumber: t,
                    duration,
                    filename,
                    ext: album.ext,
                    albumArtKey: album.artKey,
                });
            }
            albumIdx++;
        }

        return { tracks, albumArtMap };
    }

    // ── Public API ─────────────────────────────────────────────────────

    /**
     * Generate synthetic local music library and render the songs view.
     * @param {number} count - Number of tracks to generate (default 11000)
     */
    window.generateTestLibrary = function(count = 11000) {
        const explorer = window.__zuneExplorer;
        if (!explorer) {
            console.error('ZuneExplorer instance not found. Are you in dev mode?');
            return;
        }

        console.time('generateTestLibrary');

        const { tracks, albumArtMap } = generateTrackPool(count);
        const lib = explorer.musicLibrary;

        // Clear existing data
        lib.tracks.clear();
        lib.albums.clear();
        lib.artists.clear();
        lib.genres.clear();
        lib.albumArtMap = albumArtMap;

        // Populate tracks map (keyed by fake path)
        for (let i = 0; i < tracks.length; i++) {
            const t = tracks[i];
            const fakePath = `/test-music/${t.artist}/${t.album}/${t.filename}`;
            lib.tracks.set(fakePath, {
                path: fakePath,
                title: t.title,
                artist: t.artist,
                album: t.album,
                albumArtist: t.albumArtist,
                genre: t.genre,
                year: t.year,
                trackNumber: t.trackNumber,
                duration: t.duration,
                albumArtKey: t.albumArtKey,
            });
        }

        lib.scanState = 'complete';
        lib.scannedCount = count;
        lib.totalCount = count;

        // Rebuild indexes and render
        explorer.rebuildMusicIndexes();

        console.timeEnd('generateTestLibrary');
        console.log(
            `Generated: ${lib.tracks.size} tracks, ` +
            `${lib.albums.size} albums, ` +
            `${lib.artists.size} artists, ` +
            `${lib.genres.size} genres, ` +
            `${Object.keys(albumArtMap).length} album art entries`
        );

        // Navigate to music songs view to see the result
        if (explorer.currentCategory === 'music' && explorer.currentView === 'content') {
            explorer.renderMusicSubContent();
        } else {
            console.log('Navigate to music > songs to see the generated library.');
        }

        return { tracks: lib.tracks.size, albums: lib.albums.size, artists: lib.artists.size };
    };

    /**
     * Generate synthetic device browse data and populate the sync panel.
     * Some tracks overlap with local library (for matched diff), most are device-only.
     * @param {number} count - Number of device tracks to generate (default 5000)
     * @param {number} overlapPct - Percentage of tracks that match local library (default 30)
     */
    window.generateTestDevice = function(count = 5000, overlapPct = 30) {
        const explorer = window.__zuneExplorer;
        if (!explorer) {
            console.error('ZuneExplorer instance not found. Are you in dev mode?');
            return;
        }

        const panel = explorer.zunePanel;
        if (!panel) {
            console.error('ZuneSyncPanel not found.');
            return;
        }

        console.time('generateTestDevice');

        // Generate device-only tracks
        const overlapCount = Math.floor(count * overlapPct / 100);
        const uniqueCount = count - overlapCount;
        const { tracks: uniqueTracks, albumArtMap } = generateTrackPool(uniqueCount);

        const music = [];
        let handleCounter = 10000;

        // Add unique device tracks
        for (const t of uniqueTracks) {
            music.push({
                handle: handleCounter++,
                filename: t.filename,
                title: t.title,
                artist: t.artist,
                album: t.album,
                genre: t.genre,
                duration: t.duration * 1000, // device duration is in ms
                trackNumber: t.trackNumber,
                size: 3000000 + Math.floor(Math.random() * 7000000), // 3-10 MB
                format: FORMAT_CODES[t.ext] || 0x3009,
                albumArtKey: t.albumArtKey,
            });
        }

        // Add overlapping tracks (copy from local library with different handles)
        const localTracks = [...explorer.musicLibrary.tracks.values()];
        const overlapSource = localTracks.slice(0, Math.min(overlapCount, localTracks.length));

        for (const lt of overlapSource) {
            const basename = lt.path.split(/[/\\]/).pop();
            music.push({
                handle: handleCounter++,
                filename: basename,
                title: lt.title,
                artist: lt.artist,
                album: lt.album,
                genre: lt.genre,
                duration: (lt.duration || 200) * 1000,
                trackNumber: lt.trackNumber || 1,
                size: 3000000 + Math.floor(Math.random() * 7000000),
                format: 0x3009,
                albumArtKey: lt.albumArtKey,
            });
            // Copy art from local map if available
            if (lt.albumArtKey && explorer.musicLibrary.albumArtMap[lt.albumArtKey]) {
                albumArtMap[lt.albumArtKey] = explorer.musicLibrary.albumArtMap[lt.albumArtKey];
            }
        }

        // Build browse data
        panel.browseData = {
            music,
            videos: [],
            pictures: [],
            albumArtMap,
        };
        panel.browseAlbumArtMap = albumArtMap;

        // Simulate connected state
        panel.state = 'ready';
        panel.deviceModel = 'Test Zune HD';

        console.timeEnd('generateTestDevice');
        console.log(
            `Generated: ${music.length} device tracks ` +
            `(${uniqueCount} unique + ${overlapSource.length} overlapping), ` +
            `${Object.keys(albumArtMap).length} album art entries`
        );

        // If diff view is active, recompute and re-render
        if (panel.diffActive) {
            panel._computeDiff();
            panel._enrichDeviceArt();
            panel._renderDiffSummary();
            panel._destroyDiffScroller();
            panel._renderDiffList();
            console.log(
                `Diff: ${panel.diffResult.matched.length} matched, ` +
                `${panel.diffResult.localOnly.length} local-only, ` +
                `${panel.diffResult.deviceOnly.length} device-only`
            );
        } else {
            console.log('Open the sync panel diff view to see the generated device data.');
            console.log('Tip: Run generateTestDevice() again after opening the diff view.');
        }

        return {
            total: music.length,
            unique: uniqueCount,
            overlapping: overlapSource.length,
        };
    };

    /**
     * Clear all test data and reset views.
     */
    window.clearTestData = function() {
        const explorer = window.__zuneExplorer;
        if (!explorer) return;

        const lib = explorer.musicLibrary;
        lib.tracks.clear();
        lib.albums.clear();
        lib.artists.clear();
        lib.genres.clear();
        lib.albumArtMap = {};
        lib.sortedSongs = [];
        lib.sortedAlbums = [];
        lib.sortedArtists = [];
        lib.scanState = 'idle';
        lib.scannedCount = 0;
        lib.totalCount = 0;

        // Destroy songs scroller if active
        if (explorer.songsScroller) {
            explorer.songsScroller.destroy();
            explorer.songsScroller = null;
            explorer.songsLetterMap = null;
        }

        const panel = explorer.zunePanel;
        if (panel) {
            panel.browseData = null;
            panel.browseAlbumArtMap = {};
            panel.diffResult = null;
            panel._destroyBrowseScroller();
            panel._destroyDiffScroller();
        }

        console.log('Test data cleared.');

        if (explorer.currentCategory === 'music' && explorer.currentView === 'content') {
            explorer.renderMusicSubContent();
        }
    };

    /**
     * Print DOM and memory stats for performance debugging.
     */
    window.stressStats = function() {
        const nodeCount = document.querySelectorAll('*').length;
        const vsRows = document.querySelectorAll('.vs-row').length;
        const mem = performance.memory
            ? `${Math.round(performance.memory.usedJSHeapSize / 1024 / 1024)}MB used / ${Math.round(performance.memory.totalJSHeapSize / 1024 / 1024)}MB total`
            : 'N/A (enable --enable-precise-memory-info)';

        const explorer = window.__zuneExplorer;
        const trackCount = explorer ? explorer.musicLibrary.tracks.size : 0;

        console.log(`DOM nodes: ${nodeCount}`);
        console.log(`VS rows in DOM: ${vsRows}`);
        console.log(`Music tracks: ${trackCount}`);
        console.log(`JS Heap: ${mem}`);

        return { nodeCount, vsRows, trackCount };
    };

    console.log(
        '%c Test Data Generator loaded %c\n' +
        '  generateTestLibrary(11000)  — synthetic local tracks\n' +
        '  generateTestDevice(5000)    — synthetic device tracks\n' +
        '  clearTestData()             — reset everything\n' +
        '  stressStats()               — DOM/memory stats',
        'background: #ff6900; color: black; font-weight: bold; padding: 2px 6px; border-radius: 3px;',
        ''
    );
})();
