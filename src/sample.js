// A small quiz to try the game with when there are no slides to hand.
export const sample = {
  title: 'How the web works',
  seconds: 20,
  questions: [
    {
      q: 'You type a web address and press enter. What does your computer need to find out first?',
      options: ['The IP address for that name', 'The size of the page', 'Which browser the server uses', 'The password for the site'],
      answer: 0,
      explain: 'Names are for people. DNS turns the name into an IP address, and only then can the browser connect.',
    },
    {
      q: 'Which status code means the page you asked for isn’t there?',
      options: ['200', '301', '404', '500'],
      answer: 2,
      explain: '404 is Not Found. 200 is fine, 301 is a redirect and 500 means the server broke.',
    },
    {
      q: 'What does the S in HTTPS add?',
      options: ['Faster loading', 'Encryption between you and the server', 'Space for bigger files', 'A login for the site'],
      answer: 1,
      explain: 'The traffic is encrypted with TLS, so someone on the same wifi can’t read or change it.',
    },
    {
      q: 'A form saves a new order on the server. Which HTTP method fits best?',
      options: ['GET', 'POST', 'HEAD', 'OPTIONS'],
      answer: 1,
      explain: 'POST sends data that creates something. GET is only meant to read.',
    },
    {
      q: 'Why can’t a quiz game like this run on plain HTTP requests alone?',
      options: ['HTTP can’t send text', 'HTTP is too slow for phones', 'The server can’t push to the browser unless asked', 'HTTP only works on laptops'],
      answer: 2,
      explain: 'With plain HTTP the browser always asks first. A WebSocket stays open so the server can send the next question to everyone at once.',
    },
    {
      q: 'Where does a cookie live?',
      options: ['On the server only', 'In the browser, sent along with requests', 'Inside the page’s HTML', 'In the DNS record'],
      answer: 1,
      explain: 'The server sets it, the browser stores it and sends it back with each request to that site.',
    },
  ],
}
