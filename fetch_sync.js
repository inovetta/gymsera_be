fetch('http://localhost:3000/api/v1/debug-sync-db')
  .then(res => res.text())
  .then(text => console.log(text))
  .catch(err => console.error(err));
