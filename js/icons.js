/*
 * icons.js — minimalist line icons (Lucide/Feather style).
 * Each is an inline SVG sized to 1em and themed via currentColor, so an
 * icon inherits the colour and size of whatever element holds it.
 * Static spots use [data-icon="name"] (filled by applyIcons in main.js);
 * dynamic toggles set innerHTML = Icons.name directly.
 */
window.Icons = (function () {
    var S = 'class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
    var F = 'class="ic" viewBox="0 0 24 24" fill="currentColor" stroke="none"';
    return {
        play:    '<svg ' + F + '><path d="M7 4.6v14.8a1 1 0 0 0 1.5.86l12-7.4a1 1 0 0 0 0-1.72l-12-7.4A1 1 0 0 0 7 4.6z"/></svg>',
        pause:   '<svg ' + F + '><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
        restart: '<svg ' + S + '><path d="M3 12a9 9 0 1 0 2.7-6.4"/><path d="M3 4v4h4"/></svg>',
        volume:  '<svg ' + S + '><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6.5a8 8 0 0 1 0 11"/></svg>',
        mute:    '<svg ' + S + '><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><line x1="16" y1="9.5" x2="22" y2="14.5"/><line x1="22" y1="9.5" x2="16" y2="14.5"/></svg>',
        folder:  '<svg ' + S + '><path d="M3 7a2 2 0 0 1 2-2h3.4l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
        plus:    '<svg ' + S + '><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
        chevronRight: '<svg ' + S + ' stroke-width="2.3"><polyline points="9 6 15 12 9 18"/></svg>',
        chevronUp:    '<svg ' + S + '><polyline points="6 15 12 9 18 15"/></svg>',
        star:    '<svg ' + S + ' stroke-width="1.8"><path d="M12 3.6l2.6 5.25 5.8.85-4.2 4.08.99 5.76L12 16.8l-5.19 2.74.99-5.76-4.2-4.08 5.8-.85z"/></svg>',
        pencil:  '<svg ' + S + '><path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17z"/><line x1="13.5" y1="6.5" x2="17.5" y2="10.5"/></svg>',
        check:   '<svg ' + S + ' stroke-width="2.3"><polyline points="5 12 10 17 19 7"/></svg>',
        grid:    '<svg ' + S + '><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
        list:    '<svg ' + S + '><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.3" fill="currentColor" stroke="none"/></svg>',
        size:    '<svg ' + S + '><rect x="3" y="3" width="18" height="18" rx="2.5"/><rect x="8" y="8" width="8" height="8" rx="1.5"/></svg>',
        search:  '<svg ' + S + '><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>'
    };
})();
