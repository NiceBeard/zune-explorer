/**
 * VirtualScroller — renders only visible rows from a large dataset.
 *
 * Usage:
 *   const vs = new VirtualScroller({
 *       container,                     // scrollable DOM element
 *       rowTypes: {
 *           track: { height: 48, className: 'music-song-row' },
 *           letter: { height: 64, className: 'music-letter-row' },
 *       },
 *       renderRow(el, index, entry),   // populate a row element
 *       overscan: 20,                  // extra rows above/below viewport
 *   });
 *   vs.setData(entries);              // [{ type: 'track', data: {...} }, ...]
 */
class VirtualScroller {
    /**
     * @param {Object} opts
     * @param {HTMLElement} opts.container   - scrollable DOM element
     * @param {Object}      opts.rowTypes    - map of type name => { height, className }
     * @param {Function}    opts.renderRow   - (el, index, entry) => void
     * @param {number}      [opts.overscan]  - extra rows above/below viewport (default 20)
     */
    constructor({ container, rowTypes, renderRow, overscan = 20 }) {
        this._container = container;
        this._rowTypes = rowTypes;
        this._renderRow = renderRow;
        this._overscan = overscan;

        /** @type {Array<{type: string, data: *}>} */
        this._entries = [];

        /** @type {Array<{type: string, offset: number, height: number}>} */
        this._positionMap = [];

        this._totalHeight = 0;

        // Measure actual row heights from hidden prototypes
        this._measuredHeights = {};
        this._measureRowHeights();

        // Build DOM structure
        this._spacer = document.createElement('div');
        this._spacer.className = 'vs-spacer';
        this._container.appendChild(this._spacer);

        this._rowContainer = document.createElement('div');
        this._rowContainer.style.position = 'relative';
        this._rowContainer.style.width = '100%';
        this._container.appendChild(this._rowContainer);

        // Row pools per type for recycling
        /** @type {Object<string, HTMLElement[]>} */
        this._pools = {};
        for (const typeName of Object.keys(this._rowTypes)) {
            this._pools[typeName] = [];
        }

        /** @type {Map<number, HTMLElement>} active rows keyed by data index */
        this._activeRows = new Map();

        // Track rendered range
        this._renderedStart = -1;
        this._renderedEnd = -1;

        // Scroll handler
        this._rafId = null;
        this._scrollPending = false;
        this._onScroll = () => {
            if (!this._scrollPending) {
                this._scrollPending = true;
                this._rafId = requestAnimationFrame(() => {
                    this._scrollPending = false;
                    this._updateVisibleRows();
                });
            }
        };
        this._container.addEventListener('scroll', this._onScroll, { passive: true });
    }

    /**
     * Measure actual row heights by creating hidden off-screen prototype elements.
     */
    _measureRowHeights() {
        for (const [typeName, typeConfig] of Object.entries(this._rowTypes)) {
            const proto = document.createElement('div');
            proto.className = `vs-row ${typeConfig.className}`;
            // Position off-screen to measure without layout disruption
            proto.style.position = 'absolute';
            proto.style.top = '-9999px';
            proto.style.left = '-9999px';
            proto.style.visibility = 'hidden';
            proto.style.width = '100%';
            // Do NOT set height — let CSS classes determine natural height.
            // typeConfig.height is only a fallback if measurement returns 0.
            document.body.appendChild(proto);

            const rect = proto.getBoundingClientRect();
            this._measuredHeights[typeName] = rect.height || typeConfig.height;

            document.body.removeChild(proto);
        }
    }

    /**
     * Build the position map from entries using measured heights.
     */
    _buildPositionMap() {
        this._positionMap = new Array(this._entries.length);
        let offset = 0;
        for (let i = 0; i < this._entries.length; i++) {
            const entry = this._entries[i];
            const height = this._measuredHeights[entry.type] || 48;
            this._positionMap[i] = { type: entry.type, offset, height };
            offset += height;
        }
        this._totalHeight = offset;
    }

    /**
     * Binary search to find the first index whose offset + height straddles
     * or comes after the given scroll offset.
     * @param {number} targetOffset
     * @returns {number}
     */
    _findIndexAtOffset(targetOffset) {
        const map = this._positionMap;
        if (map.length === 0) return 0;

        let lo = 0;
        let hi = map.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const pos = map[mid];
            if (pos.offset + pos.height <= targetOffset) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    /**
     * Acquire a row element of the given type from the pool, or create one.
     * @param {string} typeName
     * @returns {HTMLElement}
     */
    _acquireRow(typeName) {
        const pool = this._pools[typeName];
        if (pool && pool.length > 0) {
            return pool.pop();
        }
        const typeConfig = this._rowTypes[typeName];
        const el = document.createElement('div');
        el.className = `vs-row ${typeConfig ? typeConfig.className : ''}`;
        el.style.position = 'absolute';
        el.style.left = '0';
        el.style.width = '100%';
        return el;
    }

    /**
     * Return a row element to the pool for recycling.
     * @param {string} typeName
     * @param {HTMLElement} el
     */
    _releaseRow(typeName, el) {
        const pool = this._pools[typeName];
        if (pool) {
            pool.push(el);
        }
    }

    /**
     * Core render loop: determine which rows are visible, recycle out-of-range
     * rows, and render newly visible rows.
     */
    _updateVisibleRows() {
        if (this._entries.length === 0) {
            this._recycleAll();
            return;
        }

        const scrollTop = this._container.scrollTop;
        const viewportHeight = this._container.clientHeight;

        // Find visible range with overscan
        const startIdx = Math.max(0, this._findIndexAtOffset(scrollTop) - this._overscan);
        const endIdx = Math.min(
            this._entries.length - 1,
            this._findIndexAtOffset(scrollTop + viewportHeight) + this._overscan
        );

        // Quick out if range hasn't changed
        if (startIdx === this._renderedStart && endIdx === this._renderedEnd) {
            return;
        }

        // Recycle rows that are no longer in range
        for (const [index, el] of this._activeRows) {
            if (index < startIdx || index > endIdx) {
                const typeName = this._entries[index].type;
                if (el.parentNode) {
                    el.parentNode.removeChild(el);
                }
                this._releaseRow(typeName, el);
                this._activeRows.delete(index);
            }
        }

        // Render rows that are newly in range
        for (let i = startIdx; i <= endIdx; i++) {
            if (this._activeRows.has(i)) continue;

            const entry = this._entries[i];
            const pos = this._positionMap[i];
            const el = this._acquireRow(entry.type);

            el.style.top = pos.offset + 'px';
            el.style.height = pos.height + 'px';
            el.setAttribute('data-index', i);

            this._renderRow(el, i, entry);

            this._rowContainer.appendChild(el);
            this._activeRows.set(i, el);
        }

        this._renderedStart = startIdx;
        this._renderedEnd = endIdx;
    }

    /**
     * Recycle all active rows back to their pools.
     */
    _recycleAll() {
        for (const [index, el] of this._activeRows) {
            const typeName = this._entries[index] ? this._entries[index].type : null;
            if (el.parentNode) {
                el.parentNode.removeChild(el);
            }
            if (typeName && this._pools[typeName]) {
                this._releaseRow(typeName, el);
            }
        }
        this._activeRows.clear();
        this._renderedStart = -1;
        this._renderedEnd = -1;
    }

    /**
     * Set or replace the data entries.
     * @param {Array<{type: string, data: *}>} entries
     * @param {Object} [opts]
     * @param {boolean} [opts.preserveScroll] - if true, save/restore scrollTop
     */
    setData(entries, opts = {}) {
        const savedScroll = opts.preserveScroll ? this._container.scrollTop : 0;

        this._recycleAll();
        this._entries = entries || [];
        this._buildPositionMap();

        // Update spacer height
        this._spacer.style.height = this._totalHeight + 'px';

        if (opts.preserveScroll) {
            this._container.scrollTop = savedScroll;
        }

        this._updateVisibleRows();
    }

    /**
     * Build a letter-to-offset map for alpha-jump navigation.
     * Scans entries for type 'letter' and reads the first character of data.letter
     * (or data itself if it's a string).
     * @returns {Object<string, number>}
     */
    buildLetterPositionMap() {
        const map = {};
        for (let i = 0; i < this._entries.length; i++) {
            const entry = this._entries[i];
            if (entry.type === 'letter') {
                let letter = null;
                if (entry.letter) {
                    letter = entry.letter.charAt(0).toLowerCase();
                } else if (typeof entry.data === 'string') {
                    letter = entry.data.charAt(0).toLowerCase();
                } else if (entry.data && entry.data.letter) {
                    letter = entry.data.letter.charAt(0).toLowerCase();
                }
                if (letter && !map.hasOwnProperty(letter)) {
                    map[letter] = this._positionMap[i].offset;
                }
            }
        }
        return map;
    }

    /**
     * Scroll the container to a pixel offset.
     * @param {number} offset
     */
    scrollToOffset(offset) {
        this._container.scrollTop = offset;
        // Force immediate update
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._scrollPending = false;
        }
        this._updateVisibleRows();
    }

    /**
     * Scroll the container so that the entry at the given index is visible.
     * @param {number} index
     */
    scrollToIndex(index) {
        if (index < 0 || index >= this._positionMap.length) return;
        this.scrollToOffset(this._positionMap[index].offset);
    }

    /**
     * Get the entry at a given index.
     * @param {number} index
     * @returns {{type: string, data: *}|undefined}
     */
    getEntryAtIndex(index) {
        return this._entries[index];
    }

    /**
     * Re-render all currently active (visible) rows in place without
     * changing scroll position or recycling.
     */
    refresh() {
        for (const [index, el] of this._activeRows) {
            const entry = this._entries[index];
            if (entry) {
                this._renderRow(el, index, entry);
            }
        }
    }

    /**
     * Clean up: remove listeners, cancel pending RAF, recycle all rows,
     * remove spacer and row container.
     */
    destroy() {
        this._container.removeEventListener('scroll', this._onScroll);
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        this._recycleAll();
        if (this._spacer.parentNode) {
            this._spacer.parentNode.removeChild(this._spacer);
        }
        if (this._rowContainer.parentNode) {
            this._rowContainer.parentNode.removeChild(this._rowContainer);
        }
        this._entries = [];
        this._positionMap = [];
        this._pools = {};
    }
}
