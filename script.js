// BLOG POSTS
const blogPosts = [
  {
    title: "First Project",
    date: "2025-08-01",
    desc: "Built a security scanning tool to analyze small business networks.",
    content: "Full write-up coming soon with code snippets and lessons learned.",
    image: "https://via.placeholder.com/400x200"
  },
  {
    title: "Thoughts on Cybersecurity",
    date: "2025-07-15",
    desc: "My take on where the industry is heading.",
    content: "We are seeing an increase in AI-driven threats, and defensive measures must evolve...",
    image: "https://via.placeholder.com/400x200"
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
