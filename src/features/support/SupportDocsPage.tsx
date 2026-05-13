type SupportDocsPageProps = {
  audience: 'admins' | 'canvassers'
  viewerRole: 'admin' | 'canvasser'
}

function SupportHeader({ title }: { title: string }) {
  return (
    <header className="support-docs-header">
      <h1>{title}</h1>
    </header>
  )
}

/** Text line or inline screenshot inside a caption block */
type SupportCaptionPart =
  | string
  | { imageSrc: string; imageAlt: string }

type DocSection = {
  title: string
  paragraphs?: string[]
  listItems?: string[]
  imageSrc?: string
  imageAlt?: string
  /** Captions under the lead image; strings and optional inline images */
  imageCaption?: string | SupportCaptionPart[]
}

function imageCaptionParts(caption: string | SupportCaptionPart[] | undefined): SupportCaptionPart[] {
  if (caption == null) return []
  if (typeof caption === 'string') return [caption]
  return caption
}

function SupportSection({
  title,
  paragraphs,
  listItems,
  imageSrc,
  imageAlt,
  imageCaption,
}: DocSection) {
  const captions = imageCaptionParts(imageCaption)

  return (
    <section className="support-docs-section">
      <h2>{title}</h2>
      {imageSrc ? (
        <img
          className="support-docs-section-image"
          src={imageSrc}
          alt={imageAlt ?? ''}
          loading="lazy"
        />
      ) : null}
      {captions.length > 0 ? (
        <div className="support-docs-image-caption-wrap">
          {captions.map((part, i) =>
            typeof part === 'string' ? (
              <p key={i} className="support-docs-image-caption">
                {part}
              </p>
            ) : (
              <img
                key={i}
                className="support-docs-caption-inline-image"
                src={part.imageSrc}
                alt={part.imageAlt}
                loading="lazy"
              />
            ),
          )}
        </div>
      ) : null}
      {listItems && listItems.length > 0 ? (
        <ul className="support-docs-list">
          {listItems.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : (
        (paragraphs ?? []).map((paragraph, i) => <p key={i}>{paragraph}</p>)
      )}
    </section>
  )
}

export function SupportDocsPage({ audience, viewerRole }: SupportDocsPageProps) {
  const isAdmin = audience === 'admins'
  const title = isAdmin ? 'Admin Guide' : 'Canvasser Guide'

  const sections = isAdmin
    ? [
        {
          title: 'What admins can do',
          listItems: [
            'Create users, add access, and remove users',
            'View the full map, create and manage areas, assign areas to users, and track progress',
            'Mark individual addresses canvassed or uncanvassed, and sign or clear petition status',
            'Mark an entire area canvassed or uncanvassed, or bulk-update petition signatures, when needed',
          ],
        },
        {
          title: 'Managing users',
          imageSrc: '/images/support-admin-manage-users.png',
          imageAlt:
            'Admin Access panel with user list, roles, and Add user button.',
          imageCaption: [
            'Open Admin Access from the top navigation to manage who can sign in and what role they have.',
            'From this page you can add users, edit users, and delete users.',
            'Users must first be added here as Canvassers before they can be assigned areas.',
          ],
        },
        {
          title: 'Understanding the admin map',
          imageSrc: '/images/support-admin-map-view.png',
          imageAlt:
            'Admin map showing labeled areas, draw tools, and Map and Admin Access navigation.',
          imageCaption: [
            'The admin map shows all created areas. Each area has a label and can be selected either from the map or from the side panel.',
            {
              imageSrc: '/images/support-admin-no-area-selected.png',
              imageAlt:
                'Admin map with no area selected: address dots shown across the full map.',
            },
            'When no area is selected, address dots can be shown across the full map.',
            {
              imageSrc: '/images/support-admin-area-selected.png',
              imageAlt:
                'Admin map with an area selected: map framed on the area and dots only inside it.',
            },
            'When an area is selected, the map centers on that area. If dots are turned on, only the dots in that area are shown.',
          ],
        },
        {
          title: 'Creating an area',
          imageSrc: '/images/support-admin-draw-geofence.png',
          imageAlt:
            'Drawing a new area on the map with polygon tool, Finish and Cancel controls.',
          imageCaption: [
            'Select the polygon icon on the map to enter draw mode.', 
            'Once in draw mode, you can draw a new area around the neighborhood or section you want to assign. After drawing it, save it and give it a clear name.',
            'Area names should describe the place or section, not just the person working it, whenever possible.',
          ],
        },
        {
          title: 'Assigning an area',
          paragraphs: [
            'Select an area, then assign it to a user by entering or selecting their email. Once assigned, that user will see the area after signing in.',
            'You can reassign an area later if needed.',
          ],
        },
        {
          title: 'Renaming an area',
          paragraphs: [
            'Select the area from the map or side panel. Update the area name in the details panel and save your change.',
          ],
        },
        {
          title: 'Viewing progress',
          paragraphs: [
            'Select an area to view its progress. Canvassed is shown as a count and percentage of addresses in that area; petitions signed are shown as a total signature count.',
          ],
        },
        {
          title: 'Marking addresses',
          paragraphs: [
            'Admins can mark individual addresses canvassed or uncanvassed, and sign or clear petition status, by clicking an address dot and using the action buttons.',
            'Admins can also mark an address uncanvassed if a correction is needed.',
          ],
        },
        {
          title: 'Marking an entire area',
          paragraphs: [
            'If needed, admins can mark a full area canvassed or uncanvassed, or mark all addresses signed petition or all unsigned, from the area actions menu.',
            'Use this carefully, since it affects all addresses in the selected area.',
          ],
        },
        {
          title: 'Best practices for admins',
          paragraphs: [
            'Create areas before canvassing starts so assignments are clear.',
            'Use clear area names so reassignment is easy later.',
            'Check progress by area instead of relying on memory or text updates.',
            'Use whole-area actions only when you are sure the area should be updated in bulk.',
          ],
        },
      ]
    : [
        {
          title: 'What you can do in this app',
          listItems: [
            'Sign in',
            'View the areas assigned to you',
            'Mark addresses as canvassed and record petition signatures from either the map or the address list',
            'Track canvassed progress by area and see total petitions signed',
          ],
        },
        {
          title: 'Viewing your assigned areas',
          imageSrc: '/images/support-canvasser-landing.png',
          imageAlt:
            'Canvasser map view showing assigned area with address dots and progress at the bottom.',
          imageCaption:
            'Your assigned areas appear in a list and on the map. Click an area to open it and view its progress.',
        },
        {
          title: 'Using the map',
          imageSrc: '/images/support-canvasser-marked-canvassed.png',
          imageAlt:
            'Address popup on the map with full address and buttons for canvassed and petition actions.',
          imageCaption: [
            'When you open an assigned area, you can view its addresses on the map and mark canvassed status or petition signatures.',
            'Tap an address dot, then use the buttons to mark canvassed or sign/clear petition.',
            'You can also mark an address uncanvassed or clear petition the same way.',
          ],
        },
        {
          title: 'Using address view',
          imageSrc: '/images/support-canvass-address-view.png',
          imageAlt:
            'Address list view with streets grouped, expanded street showing addresses and action buttons.',
          imageCaption: [
            'In addition to the map view, you can also view addresses in your area using the address view. In this view, addresses are grouped by street.',
            'Open a street section to see the addresses in that group. Use the buttons next to an address to mark canvassed or sign/clear petition.',
            'This view is helpful when map dots are close together or when you want to work through a street in order.',
          ],
        },
      ]

  return (
    <main className="support-docs-shell">
      <div className="support-docs-card">
        <div className="support-docs-toolbar">
          <a className="support-docs-back" href="/">
            Back to Canvass
          </a>
          {viewerRole === 'admin' ? (
            <nav className="support-docs-nav" aria-label="Guide versions">
              <a
                className={isAdmin ? 'support-docs-link active' : 'support-docs-link'}
                href="/support/admins"
              >
                Admin guide
              </a>
              <a
                className={!isAdmin ? 'support-docs-link active' : 'support-docs-link'}
                href="/support/canvassers"
              >
                Canvasser guide
              </a>
            </nav>
          ) : null}
        </div>
        <SupportHeader title={title} />
        <article className="support-docs-content">
          {sections.map((section) => (
            <SupportSection key={section.title} {...section} />
          ))}
        </article>
      </div>
    </main>
  )
}
