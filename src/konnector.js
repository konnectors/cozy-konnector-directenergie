const {log, requestFactory, saveBills, BaseKonnector, errors} = require('cozy-konnector-libs')
const request = requestFactory({
  // debug: true,
  cheerio: true,
  json: false,
  jar: true
})
const moment = require('moment')

// BaseKonnector methods will be accessible with a need to bind : terminate, saveAccountData,
// getAccountData
// it is also possible to implement saveBills, saveFiles etc, which can get the data directly in
// the Konnector : fields, folderPath
class Konnector extends BaseKonnector {
  // the authenticate method can be called independently and send the LOGIN_OK event
  // an error in this method directly causes a LOGIN_FAILED (in the error message is not in the
  // list of known errors
  // automatically
  // Possible for konitor to only run this method for its tests
  // This method must return a Promise or will fail
  // Will get a default implementation which returns a resolved promise
  authenticate (fields) {
    return checkFields(fields)
      .then(fields => doLogin(fields))
      .then($ => checkLoginOk($))
      .then($ => selectActiveAccount())
  }

  // fetch the data from the target and create an array of objects from it
  // the runner will detect the number of items and log it and display it in debug mode
  fetch () {
    log('info', 'Fetching bills')
    return request('https://clients.direct-energie.com/mes-factures/ma-facture-mon-echeancier/')
      .then($ => {
        log('info', 'Parsing bills')
        const bills = []

        Array.from($('.ec_fr_historique_facture_echeancier__liste > div > .row')).forEach(row => {
          const $row = $(row)

          const type = getRowType($row)

          const billRelativeUrl = $row.find('a:contains("Télécharger")').attr('href')
          const billEmissionDate = moment($row.find('.columns.nine > .row .columns.two').text(), 'DD/MM/YYYY')

          Array.from($row.find('table tbody tr')).forEach(tr => {
            const $tr = $(tr)
            if ($tr.find('img[src="/typo3conf/ext/de_facturation/Ressources/Images/ech_ok.png"]').length === 0) return

            const [, amount, date] = Array.from($tr.find('td')).map(elem => $(elem).text())
            const dateMoment = moment(date, 'DD/MM/YYYY')
            bills.push({
              amount: normalizeAmount(amount),
              date: dateMoment.toDate(),
              fileurl: `https://clients.direct-energie.com/${billRelativeUrl}`,
              filename: `echeancier_${type}_${billEmissionDate.format('YYYYMMDD')}_directenergie.pdf`
            })
          })
        })
        log('info', `found ${bills.length} bills`)

        return bills
      })
  }

  // saves the data to the cozy
  // saveBills could be it's default implementation
  synchronize (bills, folderPath) {
    return saveBills(bills, folderPath, {
      identifiers: ['direct energie']
    })
  }
}

module.exports = Konnector

const checkFields = fields => {
  const {login, password} = fields
  log('Checking the presence of the login and password')
  if (fields.login === undefined) {
    throw new Error('Login is missing')
  }
  if (fields.password === undefined) {
    throw new Error('Password is missing')
  }
  return Promise.resolve({
    login: login,
    password: password
  })
}

const doLogin = (fields) => {
  const {login, password} = fields
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
  return request('https://clients.direct-energie.com/mon-compte/gerer-mes-comptes')
    .then($ => {
      const activeAccounts = $('.compte-actif')

      if (activeAccounts.length === 0) {
        throw new Error('No active accounts for this login.')
      }

      const anchors = $(activeAccounts[0]).parent().find('a')

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
