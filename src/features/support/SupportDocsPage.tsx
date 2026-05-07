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

type DocSection = {
  title: string
  paragraphs?: string[]
  listItems?: string[]
  imageSrc?: string
  imageAlt?: string
}

function SupportSection({ title, paragraphs, listItems, imageSrc, imageAlt }: DocSection) {
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
          paragraphs: [
            'Admins can view the full map, create and manage areas, assign areas to users, and track progress. Admins can also mark individual addresses canvassed or uncanvassed, and can mark an entire area canvassed or uncanvassed when needed.',
          ],
        },
        {
          title: 'Signing in',
          paragraphs: [
            'Open Canvass and sign in using the email link sent to you. After signing in, you will land on the main map view.',
          ],
        },
        {
          title: 'Understanding the admin map',
          paragraphs: [
            'The admin map shows all created areas. Each area has a label and can be selected either from the map or from the side panel.',
            'When no area is selected, address dots can be shown across the full map.',
            'When an area is selected, the map centers on that area. If dots are turned on, only the dots in that area are shown.',
          ],
        },
        {
          title: 'Creating an area',
          paragraphs: [
            'Use the map tools to draw a new area around the neighborhood or section you want to assign. After drawing it, save it and give it a clear name.',
            'Area names should describe the place or section, not just the person working it, whenever possible.',
          ],
        },
        {
          title: 'Renaming an area',
          paragraphs: [
            'Select the area from the map or side panel. Update the area name in the details panel and save your change.',
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
          title: 'Viewing progress',
          paragraphs: [
            'Select an area to view its progress. Progress is shown as a number and percentage based on how many addresses in that area have been marked canvassed.',
          ],
        },
        {
          title: 'Marking addresses',
          paragraphs: [
            'Admins can mark individual addresses canvassed by clicking an address dot and using the action button.',
            'Admins can also mark an address uncanvassed if a correction is needed.',
          ],
        },
        {
          title: 'Marking an entire area',
          paragraphs: [
            'If needed, admins can mark a full area canvassed or uncanvassed from the area controls.',
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
            'Track progress for each area',
            'Mark addresses as canvassed from either the map or the address list',
          ],
        },
        {
          title: 'Viewing your areas',
          imageSrc: '/images/support-canvasser-landing.png',
          imageAlt:
            'Canvasser map view showing assigned area with address dots and progress at the bottom.',
          paragraphs: [
            'Your assigned areas appear in a list and on the map. Click an area to open it and view its progress.',
          ],
        },
        {
          title: 'Using the map',
          paragraphs: [
            'When you open an assigned area, you can view its addresses on the map and mark them as canvassed.',
            'Tap an address dot, then use the button to mark it canvassed.',
            'You can also mark an address uncanvassed the same way.',
          ],
        },
        {
          title: 'Using address view',
          paragraphs: [
            'In addition to the map view, you can also view addresses in your area using the address view. In this view, addresses are grouped by street.',
            'Open a street section to see the addresses in that group. Use the button next to an address to mark it canvassed.',
            'This view is helpful when map dots are close together or when you want to work through a street in order.',
          ],
        },
        {
          title: 'Important limits',
          paragraphs: [
            'You will only see areas assigned to you.',
            'You cannot work outside your assigned areas.',
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
