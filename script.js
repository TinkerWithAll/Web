// BLOG POSTS
const blogPosts = [
  {
    title: "Making a router with OpenWrt and a Pi 5",
    date: "2025-08-10",
    desc: "Built a travel size router that allows me to connect to another network through WiFi and create a segment of that network for all of my devices giving me more control on the traffic and an extra layer of security.",
    content: "Sorry about that, I have not yet completed my write-up of the step by step i went through for this project.",
    image: "https://github.com/TinkerWithAll/Web/blob/main/reference/PiRouter.jpg"
  },
  {
    title: "CompTIA Security + prep",
    date: "2025-08-29",
    desc: "Time to get that first cert! I'll take you through my plan of action to get stated on the path of getting my security + Certification",
    content: "I know this is a pretty bassic certification for many Security experts but I find exams and cert nerve racking and i want to make sure that i will be ready and have my plan layed out before embarking on this journey. more to come i am currently working on this project and will update this page very soon.",
    image: "https://github.com/TinkerWithAll/Web/blob/main/reference/CompTIA%20Sec%2B.jpg"
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
