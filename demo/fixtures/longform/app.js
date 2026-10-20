/**
 * Everything on the longform page that moves. No framework and no build, like the other
 * demo pages. Content stays in index.html so a pinned element's text can be found in the
 * source; only the chart geometry is drawn here, from the data below.
 */
;(() => {
  const $ = (sel, root = document) => root.querySelector(sel)
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
  const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  const SVG = 'http://www.w3.org/2000/svg'
  const svgEl = (tag, attrs = {}, parent) => {
    const node = document.createElementNS(SVG, tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    if (parent) parent.append(node)
    return node
  }

  const whenVisible = (node, fn, threshold = 0.3) => {
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      io.disconnect()
      fn()
    }, { threshold })
    io.observe(node)
  }

  const hexA = (hex, alpha) => {
    const n = parseInt(hex.replace('#', ''), 16)
    return `rgb(${n >> 16} ${(n >> 8) & 255} ${n & 255} / ${alpha})`
  }

  // ---------------------------------------------------------------- progress + active section

  const progress = $('[data-progress]')
  let ticking = false
  const onScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight
    progress.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`
    ticking = false
  }
  addEventListener('scroll', () => {
    if (!ticking) requestAnimationFrame(onScroll)
    ticking = true
  }, { passive: true })
  onScroll()

  const navLinks = new Map($$('.topnav a').map(a => [a.hash.slice(1), a]))
  const sections = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      for (const a of navLinks.values()) a.removeAttribute('aria-current')
      navLinks.get(entry.target.id)?.setAttribute('aria-current', 'true')
    }
  }, { rootMargin: '-45% 0px -50% 0px' })
  for (const id of navLinks.keys()) {
    const section = document.getElementById(id)
    if (section) sections.observe(section)
  }

  // ---------------------------------------------------------------- sparklines

  for (const svg of $$('svg[data-spark]')) {
    const values = svg.dataset.spark.split(',').map(Number)
    const min = Math.min(...values)
    const span = Math.max(...values) - min || 1
    const points = values.map((v, i) => `${((i / (values.length - 1)) * 120).toFixed(1)},${(28 - ((v - min) / span) * 24).toFixed(1)}`)
    svgEl('path', { d: `M0,32 L${points.join(' L')} L120,32Z` }, svg)
    svgEl('polyline', { points: points.join(' ') }, svg)
  }

  // ---------------------------------------------------------------- carousels

  /** `data-carousel="slide"` translates a track; `"fade"` only moves the active class. */
  for (const root of $$('[data-carousel]')) {
    const slides = $$('[data-slide]', root)
    const track = $('.carousel__track', root)
    const dotsHost = $('[data-carousel-dots]', root)
    const delay = Number(root.dataset.autoplay) || 0
    let index = 0
    let timer

    const dots = slides.map((slide, i) => {
      const dot = document.createElement('button')
      dot.className = 'dot'
      dot.setAttribute('role', 'tab')
      dot.setAttribute('aria-label', $('h3, strong', slide)?.textContent ?? `Slide ${i + 1}`)
      dot.addEventListener('click', () => { go(i); play() })
      dotsHost?.append(dot)
      return dot
    })

    function go(i) {
      index = (i + slides.length) % slides.length
      if (root.dataset.carousel === 'slide' && track) {
        track.style.transform = `translateX(${-slides[index].offsetLeft}px)`
      }
      slides.forEach((slide, n) => slide.classList.toggle('is-active', n === index))
      dots.forEach((dot, n) => dot.setAttribute('aria-selected', String(n === index)))
    }

    function play() {
      clearInterval(timer)
      if (delay && !reduced) timer = setInterval(() => go(index + 1), delay)
    }

    const pause = () => clearInterval(timer)

    $('[data-carousel-prev]', root)?.addEventListener('click', () => { go(index - 1); play() })
    $('[data-carousel-next]', root)?.addEventListener('click', () => { go(index + 1); play() })
    root.addEventListener('pointerenter', pause)
    root.addEventListener('pointerleave', play)
    root.addEventListener('focusin', pause)
    root.addEventListener('focusout', play)
    addEventListener('resize', () => go(index))

    go(0)
    play()
  }

  // ---------------------------------------------------------------- line chart (SVG)

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov']
  const TRAVELLERS = {
    2026: [86, 104, 152, 188, 241, 322, 398, 376, 284, 171, 96],
    2025: [70, 88, 131, 162, 210, 280, 331, 318, 238, 139, 82],
  }

  for (const host of $$('[data-line-chart]')) {
    const card = host.closest('.chart-card')
    const tip = $('.tooltip', card)
    let drawnWidth = 0

    const draw = animate => {
      host.replaceChildren()
      const W = host.clientWidth
      const H = 280
      const pad = { t: 12, r: 12, b: 28, l: 40 }
      const max = 450
      const x = i => pad.l + (i / (MONTHS.length - 1)) * (W - pad.l - pad.r)
      const y = v => pad.t + (1 - v / max) * (H - pad.t - pad.b)
      const path = values => values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
      drawnWidth = W

      const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Travellers per month, 2026 against 2025' }, host)
      const gradient = svgEl('linearGradient', { id: 'lf-area', x1: 0, y1: 0, x2: 0, y2: 1 }, svgEl('defs', {}, svg))
      svgEl('stop', { offset: 0, class: 'stop-a', 'stop-opacity': 0.32 }, gradient)
      svgEl('stop', { offset: 1, class: 'stop-a', 'stop-opacity': 0 }, gradient)

      const grid = svgEl('g', { class: 'grid' }, svg)
      for (let v = 0; v <= max; v += 150) {
        svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }, grid)
        svgEl('text', { x: pad.l - 10, y: y(v) + 4, 'text-anchor': 'end' }, grid).textContent = v
      }
      MONTHS.forEach((m, i) => {
        svgEl('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }, grid).textContent = m
      })

      const last = MONTHS.length - 1
      svgEl('path', { d: `${path(TRAVELLERS[2026])} L${x(last)} ${y(0)} L${x(0)} ${y(0)}Z`, fill: 'url(#lf-area)' }, svg)
      svgEl('path', { d: path(TRAVELLERS[2025]), class: 'line line--b' }, svg)
      const current = svgEl('path', { d: path(TRAVELLERS[2026]), class: 'line line--a' }, svg)

      if (animate && !reduced) {
        const length = current.getTotalLength()
        current.style.strokeDasharray = `${length}`
        current.style.strokeDashoffset = `${length}`
        current.getBoundingClientRect()
        current.style.transition = 'stroke-dashoffset 1400ms ease'
        current.style.strokeDashoffset = '0'
        current.addEventListener('transitionend', () => { current.style.strokeDasharray = '' }, { once: true })
      }

      const cross = svgEl('line', { class: 'crosshair', y1: pad.t, y2: H - pad.b, visibility: 'hidden' }, svg)
      const dotB = svgEl('circle', { r: 5, class: 'point--b', visibility: 'hidden' }, svg)
      const dotA = svgEl('circle', { r: 5, class: 'point--a', visibility: 'hidden' }, svg)
      const hoverables = [cross, dotA, dotB]

      svg.addEventListener('pointermove', ev => {
        const box = svg.getBoundingClientRect()
        const px = ((ev.clientX - box.left) / box.width) * W
        const i = Math.max(0, Math.min(last, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * last)))
        const now = TRAVELLERS[2026][i]
        const before = TRAVELLERS[2025][i]
        const cx = x(i)

        for (const node of hoverables) node.setAttribute('visibility', 'visible')
        cross.setAttribute('x1', cx)
        cross.setAttribute('x2', cx)
        dotA.setAttribute('cx', cx)
        dotA.setAttribute('cy', y(now))
        dotB.setAttribute('cx', cx)
        dotB.setAttribute('cy', y(before))

        tip.innerHTML = `<strong>${MONTHS[i]} 2026</strong>${now} travellers · +${Math.round((now / before - 1) * 100)}% on 2025`
        tip.style.left = `${host.offsetLeft + cx}px`
        tip.style.top = `${host.offsetTop + y(now)}px`
        tip.hidden = false
      })

      svg.addEventListener('pointerleave', () => {
        tip.hidden = true
        for (const node of hoverables) node.setAttribute('visibility', 'hidden')
      })
    }

    whenVisible(card, () => draw(true))
    new ResizeObserver(() => {
      if (drawnWidth && host.clientWidth !== drawnWidth) draw(false)
    }).observe(host)
  }

  // ---------------------------------------------------------------- bars (HTML)

  for (const group of $$('[data-bars]')) {
    const bars = $$('.bar', group)
    const max = Math.max(...bars.map(bar => Number(bar.dataset.value)))
    whenVisible(group, () => {
      for (const bar of bars) bar.style.width = `${(Number(bar.dataset.value) / max) * 100}%`
    })
  }

  // ---------------------------------------------------------------- donut (SVG)

  for (const host of $$('[data-donut]')) {
    const values = host.dataset.donut.split(',').map(Number)
    const total = values.reduce((a, b) => a + b, 0)
    const R = 70
    const C = 2 * Math.PI * R
    const GAP = 3

    const svg = svgEl('svg', { viewBox: '0 0 180 180', 'aria-hidden': 'true' })
    svgEl('circle', { cx: 90, cy: 90, r: R, class: 'donut__track' }, svg)
    let offset = 0
    const segments = values.map((v, i) => {
      const length = (v / total) * C
      const circle = svgEl('circle', { cx: 90, cy: 90, r: R, class: `seg-${i + 1}` }, svg)
      circle.style.strokeDasharray = `0 ${C}`
      circle.style.strokeDashoffset = `${-offset}`
      offset += length
      return [circle, Math.max(0, length - GAP)]
    })
    host.prepend(svg)

    whenVisible(host, () => {
      for (const [circle, length] of segments) circle.style.strokeDasharray = `${length} ${C}`
    })
  }

  // ---------------------------------------------------------------- elevation (canvas)

  const STAGES = [[0, 600], [12, 1050], [24, 540], [39, 490], [55, 220]]
  const TRAIL_KM = 55
  const STEP = 0.25

  const PROFILE = []
  for (let km = 0; km <= TRAIL_KM; km += STEP) {
    const next = Math.max(1, STAGES.findIndex(([k]) => k >= km))
    const [k0, e0] = STAGES[next - 1]
    const [k1, e1] = STAGES[next]
    const t = (km - k0) / (k1 - k0)
    const eased = t * t * (3 - 2 * t)
    const texture = Math.sin(km * 1.7) * 16 + Math.sin(km * 0.53 + 1) * 24
    PROFILE.push([km, e0 + (e1 - e0) * eased + texture * Math.sin(Math.PI * t)])
  }

  for (const canvas of $$('canvas[data-elevation]')) {
    const ctx = canvas.getContext('2d')
    const pad = { t: 36, r: 12, b: 26, l: 52 }
    let hover = null

    const draw = () => {
      const dpr = devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const X = km => pad.l + (km / TRAIL_KM) * (w - pad.l - pad.r)
      const Y = m => pad.t + (1 - m / 1200) * (h - pad.t - pad.b)
      const sans = token('--sans')
      const sea = token('--sea')

      ctx.font = `12px ${sans}`
      ctx.lineWidth = 1
      ctx.strokeStyle = token('--night-rule')
      ctx.fillStyle = token('--night-dim')
      ctx.textAlign = 'right'
      for (let m = 0; m <= 1200; m += 400) {
        ctx.beginPath()
        ctx.moveTo(pad.l, Y(m))
        ctx.lineTo(w - pad.r, Y(m))
        ctx.stroke()
        ctx.fillText(`${m} m`, pad.l - 10, Y(m) + 4)
      }
      ctx.textAlign = 'center'
      for (let km = 0; km <= 50; km += 10) ctx.fillText(`${km} km`, X(km), h - 6)

      const trace = () => {
        ctx.beginPath()
        PROFILE.forEach(([km, m], i) => (i ? ctx.lineTo(X(km), Y(m)) : ctx.moveTo(X(km), Y(m))))
      }

      const fill = ctx.createLinearGradient(0, pad.t, 0, h - pad.b)
      fill.addColorStop(0, hexA(sea, 0.5))
      fill.addColorStop(1, hexA(sea, 0))
      trace()
      ctx.lineTo(X(TRAIL_KM), Y(0))
      ctx.lineTo(X(0), Y(0))
      ctx.closePath()
      ctx.fillStyle = fill
      ctx.fill()

      trace()
      ctx.strokeStyle = sea
      ctx.lineWidth = 2
      ctx.stroke()

      ctx.fillStyle = token('--white')
      for (const [km] of STAGES) {
        const [, m] = PROFILE[Math.round(km / STEP)]
        ctx.beginPath()
        ctx.arc(X(km), Y(m), 4, 0, Math.PI * 2)
        ctx.fill()
      }

      if (hover != null) {
        const [km, m] = PROFILE[hover]
        ctx.setLineDash([3, 3])
        ctx.strokeStyle = token('--night-dim')
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(X(km), pad.t)
        ctx.lineTo(X(km), h - pad.b)
        ctx.stroke()
        ctx.setLineDash([])

        ctx.fillStyle = token('--accent')
        ctx.beginPath()
        ctx.arc(X(km), Y(m), 5, 0, Math.PI * 2)
        ctx.fill()

        const label = `${km.toFixed(1)} km · ${Math.round(m)} m`
        ctx.font = `600 12px ${sans}`
        const width = ctx.measureText(label).width + 20
        const left = Math.min(Math.max(X(km) - width / 2, pad.l), w - pad.r - width)
        ctx.fillStyle = token('--white')
        ctx.beginPath()
        ctx.roundRect(left, 4, width, 24, 6)
        ctx.fill()
        ctx.fillStyle = token('--ink')
        ctx.textAlign = 'left'
        ctx.fillText(label, left + 10, 20)
      }
    }

    canvas.addEventListener('pointermove', ev => {
      const box = canvas.getBoundingClientRect()
      const km = ((ev.clientX - box.left - pad.l) / (box.width - pad.l - pad.r)) * TRAIL_KM
      const next = Math.max(0, Math.min(PROFILE.length - 1, Math.round(km / STEP)))
      if (next === hover) return
      hover = next
      draw()
    })
    canvas.addEventListener('pointerleave', () => { hover = null; draw() })
    new ResizeObserver(draw).observe(canvas)
  }

  // ---------------------------------------------------------------- gallery strip

  for (const root of $$('[data-strip]')) {
    const strip = $('.strip', root)
    const scroll = dir => strip.scrollBy({ left: dir * strip.clientWidth * 0.8, behavior: reduced ? 'auto' : 'smooth' })
    $('[data-strip-prev]', root)?.addEventListener('click', () => scroll(-1))
    $('[data-strip-next]', root)?.addEventListener('click', () => scroll(1))
  }

  // ---------------------------------------------------------------- sticky story

  for (const story of $$('[data-story]')) {
    const steps = $$('[data-step]', story)
    const images = $$('[data-step-img]', story)
    const day = $('[data-story-day]', story)
    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const n = Number(entry.target.dataset.step)
        steps.forEach(step => step.classList.toggle('is-active', step === entry.target))
        images.forEach(img => img.classList.toggle('is-active', Number(img.dataset.stepImg) === n))
        day.textContent = String(n + 1)
      }
    }, { rootMargin: '-45% 0px -45% 0px' })
    steps.forEach(step => io.observe(step))
  }

  // ---------------------------------------------------------------- departures table

  for (const root of $$('[data-departures]')) {
    const rows = $$('tbody tr', root)
    for (const cell of $$('[data-left]', root)) {
      const left = Number(cell.dataset.left)
      const cap = Number(cell.dataset.cap)
      const meter = $('.meter', cell)
      $('i', meter).style.width = `${((cap - left) / cap) * 100}%`
      meter.classList.toggle('meter--low', left > 0 && left <= 3)
      meter.classList.toggle('meter--full', left === 0)
    }

    const tabs = $$('[data-filter]', root)
    const count = $('[data-count]', root)
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        const filter = tab.dataset.filter
        tabs.forEach(t => t.setAttribute('aria-selected', String(t === tab)))
        let shown = 0
        for (const row of rows) {
          row.hidden = filter !== 'all' && row.dataset.region !== filter
          if (!row.hidden) shown++
        }
        if (count) count.textContent = String(shown)
      })
    }
  }

  // ---------------------------------------------------------------- signup

  for (const form of $$('[data-signup]')) {
    form.addEventListener('submit', ev => {
      ev.preventDefault()
      const note = $('[data-signup-note]')
      if (note) note.textContent = "You're on the list. We'll write on 1 November, and not before."
      form.reset()
    })
  }
})()
