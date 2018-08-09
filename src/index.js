const {
  log,
  BaseKonnector,
  requestFactory,
  saveBills,
  errors,
  utils
} = require('cozy-konnector-libs')
const moment = require('moment')
const request = requestFactory({
  // debug: true,
  cheerio: true,
  json: false,
  jar: true
})

const checkFields = fields => {
  log('Checking the presence of the login and password')
  if (fields.login === undefined) {
    throw new Error('Login is missing')
  }
  if (fields.password === undefined) {
    throw new Error('Password is missing')
  }
}

const doLogin = ({ login, password }) => {
  log('info', 'Logging in')
  return request({
    method: 'POST',
    url: 'https://clients.direct-energie.com/connexion-clients-particuliers/',
    form: {
      'tx_deauthentification[login]': login,
      'tx_deauthentification[password]': password,
      'tx_deauthentification[form_valid]': '1',
      'tx_deauthentification[redirect_url]': '',
      'tx_deauthentification[mdp_oublie]': 'Je+me+connecte'
    }
  })
}

const checkLoginOk = $ => {
  if ($('.formlabel-left.error').length > 0) {
    throw new Error(errors.LOGIN_FAILED)
  }
  return $
}

const selectActiveAccount = () => {
  log('info', 'Selecting active account')
  return request(
    'https://clients.direct-energie.com/mon-compte/gerer-mes-comptes'
  ).then($ => {
    const activeAccounts = $('.compte-actif')

    if (activeAccounts.length === 0) {
      throw new Error('No active accounts for this login.')
    }

    const anchors = $(activeAccounts[0])
      .parent()
      .find('a')

    let href = null
    for (let i = 0; i < anchors.length; i++) {
      href = $(anchors[i]).attr('href')
      if (href !== '#') {
        break
      }
    }

    if (href === null) {
      throw new Error("Couldn't find link to the active account.")
    }

    if (href[0] !== '/') {
      href = `/${href}`
    }

    log('info', "Going to the active account's page.")

    return request(`https://clients.direct-energie.com${href}`)
  })
}

const normalizeAmount = amount => parseFloat(amount.replace('€', '').trim())

const getRowType = $row => {
  const isGaz = $row.find('span.picto__puce__gaz').length !== 0
  const isElec = $row.find('span.picto__puce__elec').length !== 0
  return isGaz ? 'gaz' : isElec ? 'elec' : 'other'
}

const parseBills = () => {
  log('info', 'Parsing bills')
  return request(
    'https://clients.direct-energie.com/mes-factures/ma-facture-mon-echeancier/'
  ).then($ => {
    const bills = []

    Array.from(
      $('.ec_fr_historique_facture_echeancier__liste > div > .row')
    ).forEach(row => {
      const $row = $(row)

      const type = getRowType($row)

      const billRelativeUrl = $row
        .find('a:contains("Télécharger")')
        .attr('href')
      const billEmissionDate = moment(
        $row.find('.columns.nine > .row .columns.two').text(),
        'DD/MM/YYYY'
      )

      Array.from($row.find('table tbody tr')).forEach(tr => {
        const $tr = $(tr)
        if (
          $tr.find(
            'img[src="/typo3conf/ext/de_facturation/Ressources/Images/ech_ok.png"]'
          ).length === 0
        ) {
          return
        }

        const [, amount, date] = Array.from($tr.find('td')).map(elem =>
          $(elem).text()
        )
        const dateMoment = moment(date, 'DD/MM/YYYY')
        bills.push({
          amount: normalizeAmount(amount),
          date: dateMoment.toDate(),
          vendor: 'Direct Energie',
          fileurl: `https://clients.direct-energie.com/${billRelativeUrl}`,
          filename: `echeancier_${type}_${billEmissionDate.format(
            'YYYYMMDD'
          )}_directenergie.pdf`,
          metadata: {
            dateImport: new Date(),
            version: 2
          }
        })
      })
    })
    log('info', `found ${bills.length} bills`)

    return bills
  })
}

async function normalizeBills() {
  const directBills = await utils.queryAll('io.cozy.bills', {
    filename: { $regex: '_directenergie.pdf$' }
  })

  const nbNotNormalized = directBills.filter(
    doc => !doc.metadata || !doc.metadata.version === 2
  ).length
  if (nbNotNormalized) {
    log(
      'info',
      `Normalizing ${nbNotNormalized} bills without vendor attribute and with associated file ending in "_directenergie.pdf"`
    )
    await utils.batchUpdateAttributes(
      'io.cozy.bills',
      directBills.map(doc => doc._id),
      {
        vendor: 'Direct Energie',
        metadata: {
          dateImport: new Date(),
          version: 2
        }
      }
    )
  }
}

const start = async fields => {
  await normalizeBills()
  checkFields(fields)
  const $ = await doLogin(fields)
  await checkLoginOk($)
  await selectActiveAccount()
  const bills = await parseBills()
  return await saveBills(bills, fields, {
    identifiers: ['direct energie'],
    removeDuplicates: true
  })
}

module.exports = new BaseKonnector(start)
