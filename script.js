const blogPosts = [
  {
    title: "Pi Router",
    date: "2025-08-29",
    desc: "Configure OpenWrt on your Raspbery Pi 5 to add a security layer to your network.",
    content: "Soon i will post a walkthrough of how i configured my own router using openwrt on a pi so that you can secure your network too!",
    image: "https://via.placeholder.com/400x200"
  },
{
  "title": "Process of Getting My Security + Cert",
  "date": "2025-08-15",
  "desc": "A look into my journey of studying for and earning the CompTIA Security+ certification, and how it shaped my cybersecurity career.",
  "content": "Preparing for my Security+ certification was both challenging and rewarding. It gave me a structured way to deepen my understanding of core security concepts, from risk management and network security to identity, access, and cryptography. While I was already working in vulnerability management, studying for this certification pushed me to strengthen my fundamentals and think about security in a broader context. The process involved countless study hours, labs, and practice exams, but ultimately it gave me the confidence to approach my work with a stronger foundation and a mindset of continuous learning."
}
];

const blogContainer = document.getElementById("blog-container");

blogPosts.forEach(post => {
  const div = document.createElement("div");
  div.className = "blog-post";
  div.innerHTML = `
    <img src="${post.image}" alt="${post.title}" style="max-width:100%; border-radius:5px;"/>
    <h3>${post.title}</h3>
    <small>${post.date}</small>
    <p><strong>${post.desc}</strong></p>
    <p>${post.content}</p>
  `;
  div.addEventListener("click", () => {
    div.classList.toggle("expanded");
  });
  blogContainer.appendChild(div);
});

// CONTACT FORM
document.getElementById("contactForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const formData = new FormData(e.target);
  const data = Object.fromEntries(formData.entries());

  // TODO: Connect to EmailJS or Formspree to handle sending securely
  alert("Form submitted! (Backend integration needed to actually send email)");
  e.target.reset();
});
