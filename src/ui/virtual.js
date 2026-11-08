/**
 * Small variable-height virtual list. Only the rows intersecting the viewport
 * (plus overscan) exist in the DOM, so long sessions stay responsive.
 */
export class VirtualList {
  constructor(scroller, options = {}) {
    this.scroller = scroller;
    this.renderRow = options.renderRow;
    this.heightFor = options.heightFor ?? (() => 64);
    this.overscan = options.overscan ?? 8;
    this.rows = [];
    this.offsets = [];
    this.totalHeight = 0;
    this.frame = null;
    this.spacer = document.createElement("div");
    this.spacer.className = "vlist-spacer";
    this.window = document.createElement("div");
    this.window.className = "vlist-window";
    this.spacer.appendChild(this.window);
    this.scroller.replaceChildren(this.spacer);
    this.onScroll = this.onScroll.bind(this);
    this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.resizeObserver.observe(this.scroller);
  }

  setRows(rows, options = {}) {
    const previousHeight = this.totalHeight;
    const previousScrollTop = this.scroller.scrollTop;
    this.rows = rows;
    this.offsets = new Array(rows.length + 1);
    let offset = 0;
    for (let index = 0; index < rows.length; index++) {
      this.offsets[index] = offset;
      offset += Math.max(1, Number(this.heightFor(rows[index], index)) || 1);
    }
    this.offsets[rows.length] = offset;
    this.totalHeight = offset;
    this.spacer.style.height = `${offset}px`;
    if (options.preserveScroll && options.prependHeight) {
      this.scroller.scrollTop = Math.max(
        0,
        previousScrollTop + (offset - previousHeight),
      );
    } else if (options.scrollToBottom) {
      this.render();
      this.scroller.scrollTop = Math.max(0, this.totalHeight - this.scroller.clientHeight);
    } else if (options.scrollToTop) {
      this.scroller.scrollTop = 0;
    }
    this.schedule();
  }

  schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  onScroll() {
    this.schedule();
  }

  render() {
    if (this.rows.length === 0) {
      this.window.replaceChildren();
      return;
    }
    const viewportTop = this.scroller.scrollTop;
    const viewportHeight = this.scroller.clientHeight || 600;
    let low = 0;
    let high = this.rows.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.offsets[mid] + (this.offsets[mid + 1] - this.offsets[mid]) <= viewportTop) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const start = Math.max(0, low - this.overscan);
    let end = start;
    const limit = viewportTop + viewportHeight + this.overscan * 80;
    while (end < this.rows.length && this.offsets[end] < limit) end++;
    end = Math.min(this.rows.length, end + this.overscan);

    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index++) {
      const row = this.rows[index];
      const element = document.createElement("div");
      element.className = `vrow vrow-${row.type ?? "event"}`;
      element.style.position = "absolute";
      element.style.top = `${this.offsets[index]}px`;
      element.style.left = "0";
      element.style.right = "0";
      element.style.height = `${this.offsets[index + 1] - this.offsets[index]}px`;
      element.dataset.rowIndex = String(index);
      if (row.eventID) element.dataset.eventId = row.eventID;
      if (row.turnID) element.dataset.turnId = row.turnID;
      element.innerHTML = this.renderRow(row, index);
      fragment.appendChild(element);
    }
    this.window.replaceChildren(fragment);
  }

  scrollToRow(index, align = 0.25) {
    if (index < 0 || index >= this.rows.length) return;
    const offset = this.offsets[index];
    this.scroller.scrollTop = Math.max(
      0,
      offset - Math.floor(this.scroller.clientHeight * align),
    );
    this.render();
  }

  scrollToEvent(eventID, align = 0.25) {
    const index = this.rows.findIndex((row) => row.eventID === eventID);
    if (index >= 0) this.scrollToRow(index, align);
    return index;
  }

  scrollToTop() {
    this.scroller.scrollTop = 0;
    this.render();
  }

  scrollToBottom() {
    this.scroller.scrollTop = Math.max(0, this.totalHeight - this.scroller.clientHeight);
    this.render();
  }

  destroy() {
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.resizeObserver.disconnect();
    this.scroller.replaceChildren();
  }
}
